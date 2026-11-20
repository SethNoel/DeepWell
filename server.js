'use strict';

require('dotenv').config();

const path = require('node:path');
const { createServer } = require('node:http');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');

const { MONGODB_URI, MONGODB_DB } = process.env;
if (!MONGODB_URI) throw new Error('MONGODB_URI is required. Set it in your local .env file.');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const chatConnections = new Map();
const chatConversations = new Map();
const chatHistoryLimit = 100;
const authTokenLifetimeMs = 1000 * 60 * 60 * 24 * 14;

app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(async (request, response, next) => {
  const authorization = request.get('authorization');
  if (!authorization) return next();
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) return response.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
  try {
    const tokenHash = hashAccessToken(match[1]);
    const record = await request.app.locals.authTokens.findOne({
      tokenHash,
      expiresAt: { $gt: new Date() }
    });
    if (!record) return response.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
    request.citizen = record.citizen;
    request.accessTokenHash = tokenHash;
    return next();
  } catch (error) {
    return next(error);
  }
});

function publicCitizen(citizen) {
  return {
    id: String(citizen._id),
    name: citizen.name,
    email: citizen.email,
    level: citizen.level
  };
}

function requireCitizen(request, response, next) {
  if (!request.citizen) {
    return response.status(401).json({ error: 'Sign in to use the community network.' });
  }
  return next();
}

function hashAccessToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function createAccessToken(citizen) {
  const accessToken = randomBytes(32).toString('base64url');
  await app.locals.authTokens.insertOne({
    tokenHash: hashAccessToken(accessToken),
    citizenId: new ObjectId(citizen.id),
    citizen,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + authTokenLifetimeMs)
  });
  return accessToken;
}

function disconnectChatToken(tokenHash) {
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data.tokenHash === tokenHash) socket.disconnect(true);
  }
}

function validText(value, maxLength) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validEmail(value) {
  return typeof value === 'string'
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPassword(value) {
  return typeof value === 'string'
    && value.length >= 10
    && Buffer.byteLength(value, 'utf8') <= 72;
}

function validLevel(value) {
  return Number.isInteger(value) && value >= 1 && value <= 99;
}

function conversationKey(firstId, secondId) {
  return [firstId, secondId].sort().join(':');
}

function citizenRoom(citizenId) {
  return `citizen:${citizenId}`;
}

function configureChatSockets(users) {
  io.use(async (socket, next) => {
    const accessToken = socket.handshake.auth?.accessToken;
    if (typeof accessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(accessToken)) {
      return next(new Error('Sign in to use the community network.'));
    }
    try {
      const tokenHash = hashAccessToken(accessToken);
      const record = await app.locals.authTokens.findOne({
        tokenHash,
        expiresAt: { $gt: new Date() }
      });
      if (!record || !ObjectId.isValid(record.citizen.id)) {
        return next(new Error('Your sign-in has expired. Please sign in again.'));
      }
      socket.data.citizen = record.citizen;
      socket.data.tokenHash = tokenHash;
      return next();
    } catch (error) {
      return next(error);
    }
  });

  io.on('connection', socket => {
    const citizenId = socket.data.citizen.id;
    let connections = chatConnections.get(citizenId);
    const wasOnline = Boolean(connections && connections.size);
    if (!connections) {
      connections = new Set();
      chatConnections.set(citizenId, connections);
    }
    connections.add(socket.id);
    socket.join(citizenRoom(citizenId));
    socket.emit('presence_snapshot', { onlineIds: [...chatConnections.keys()] });
    if (!wasOnline) io.emit('presence', { citizenId, online: true });

    socket.on('chat:history', async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const recipientId = typeof payload?.recipientId === 'string' ? payload.recipientId : '';
      if (!/^[a-f\d]{24}$/i.test(recipientId) || recipientId === citizenId) {
        return acknowledge({ error: 'Choose another registered citizen to chat with.' });
      }
      try {
        const recipient = await users.findOne(
          { _id: new ObjectId(recipientId), isDemo: { $ne: true } },
          { projection: { _id: 1 } }
        );
        if (!recipient) return acknowledge({ error: 'Citizen not found.' });
        const messages = chatConversations.get(conversationKey(citizenId, recipientId)) || [];
        return acknowledge({ messages });
      } catch (error) {
        console.error('Could not load chat history:', error);
        return acknowledge({ error: 'Could not load this conversation.' });
      }
    });

    socket.on('chat:send', async (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const recipientId = typeof payload?.recipientId === 'string' ? payload.recipientId : '';
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!/^[a-f\d]{24}$/i.test(recipientId) || recipientId === citizenId) {
        return acknowledge({ error: 'Choose another registered citizen to chat with.' });
      }
      if (!validText(text, 1000)) {
        return acknowledge({ error: 'Messages must be between 1 and 1000 characters.' });
      }
      try {
        const recipient = await users.findOne(
          { _id: new ObjectId(recipientId), isDemo: { $ne: true } },
          { projection: { _id: 1 } }
        );
        if (!recipient) return acknowledge({ error: 'Citizen not found.' });

        const message = {
          id: randomUUID(),
          senderId: citizenId,
          recipientId,
          text,
          createdAt: new Date().toISOString()
        };
        const key = conversationKey(citizenId, recipientId);
        const messages = chatConversations.get(key) || [];
        messages.push(message);
        if (messages.length > chatHistoryLimit) messages.splice(0, messages.length - chatHistoryLimit);
        chatConversations.set(key, messages);

        io.to(citizenRoom(citizenId)).emit('chat:message', { peerId: recipientId, message });
        io.to(citizenRoom(recipientId)).emit('chat:message', { peerId: citizenId, message });
        return acknowledge({ message });
      } catch (error) {
        console.error('Could not send chat message:', error);
        return acknowledge({ error: 'Could not send this message.' });
      }
    });

    socket.on('disconnect', () => {
      const activeConnections = chatConnections.get(citizenId);
      if (!activeConnections || !activeConnections.delete(socket.id)) return;
      if (!activeConnections.size) {
        chatConnections.delete(citizenId);
        io.emit('presence', { citizenId, online: false });
      }
    });
  });
}

async function createNotification(notifications, notification) {
  await notifications.insertOne({
    ...notification,
    readBy: [],
    createdAt: new Date()
  });
}

function authLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait and try again.' }
  });
}

const authRateLimit = authLimiter();
app.use('/api/auth', (_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});
app.get('/api/auth/session', (request, response) => {
  if (!request.citizen) return response.json({ authenticated: false });
  return response.json({
    authenticated: true,
    citizen: request.citizen
  });
});

app.post('/api/auth/register', authRateLimit, async (request, response) => {
  const { name, email, password, level } = request.body || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedName || normalizedName.length > 70 || /[\u0000-\u001f\u007f]/.test(normalizedName)) {
    return response.status(400).json({ error: 'Enter a valid name (up to 70 characters).' });
  }
  if (!validEmail(normalizedEmail)) {
    return response.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!validPassword(password)) {
    return response.status(400).json({ error: 'Password must be 10 or more characters and no more than 72 UTF-8 bytes.' });
  }
  if (!validLevel(level)) {
    return response.status(400).json({ error: 'Choose a level between 1 and 99.' });
  }

  const users = request.app.locals.users;
  const passwordHash = await bcrypt.hash(password, 12);
  const citizen = {
    name: normalizedName,
    email: normalizedEmail,
    passwordHash,
    level,
    createdAt: new Date()
  };
  try {
    const result = await users.insertOne(citizen);
    citizen._id = result.insertedId;
  } catch (error) {
    if (error.code === 11000) {
      return response.status(409).json({ error: 'An account with that email already exists.' });
    }
    throw error;
  }

  const publicProfile = publicCitizen(citizen);
  const accessToken = await createAccessToken(publicProfile);
  return response.status(201).json({ citizen: publicProfile, accessToken });
});

app.post('/api/auth/login', authRateLimit, async (request, response) => {
  const { email, password } = request.body || {};
  if (!validEmail(typeof email === 'string' ? email.trim() : '') || typeof password !== 'string') {
    return response.status(400).json({ error: 'Enter your email and password.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const citizen = await request.app.locals.users.findOne({ email: normalizedEmail });
  const passwordMatches = citizen && !citizen.isDemo && Buffer.byteLength(password, 'utf8') <= 72
    ? await bcrypt.compare(password, citizen.passwordHash)
    : false;
  if (!passwordMatches) {
    return response.status(401).json({ error: 'Email or password is incorrect.' });
  }

  const publicProfile = publicCitizen(citizen);
  const accessToken = await createAccessToken(publicProfile);
  return response.json({ citizen: publicProfile, accessToken });
});

app.post('/api/auth/logout', requireCitizen, async (request, response) => {
  disconnectChatToken(request.accessTokenHash);
  await request.app.locals.authTokens.deleteOne({ tokenHash: request.accessTokenHash });
  return response.status(204).end();
});

app.patch('/api/auth/profile', requireCitizen, async (request, response) => {
  const { name, email, level } = request.body || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedName || normalizedName.length > 70 || /[\u0000-\u001f\u007f]/.test(normalizedName)) {
    return response.status(400).json({ error: 'Enter a valid name (up to 70 characters).' });
  }
  if (!validEmail(normalizedEmail)) {
    return response.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!validLevel(level)) {
    return response.status(400).json({ error: 'Choose a level between 1 and 99.' });
  }
  if (!ObjectId.isValid(request.citizen.id)) {
    return response.status(401).json({ error: 'Sign in again before updating your profile.' });
  }

  const citizenId = new ObjectId(request.citizen.id);
  try {
    const result = await request.app.locals.users.updateOne(
      { _id: citizenId, isDemo: { $ne: true } },
      { $set: { name: normalizedName, email: normalizedEmail, level, updatedAt: new Date() } }
    );
    if (!result.matchedCount) {
      return response.status(404).json({ error: 'Citizen account not found.' });
    }
  } catch (error) {
    if (error.code === 11000) {
      return response.status(409).json({ error: 'An account with that email already exists.' });
    }
    throw error;
  }

  const updatedCitizen = {
    ...request.citizen,
    name: normalizedName,
    email: normalizedEmail,
    level
  };
  await request.app.locals.authTokens.updateMany(
    { citizenId },
    { $set: { citizen: updatedCitizen } }
  );
  request.citizen = updatedCitizen;
  return response.json({ citizen: updatedCitizen });
});

app.get('/api/overview', requireCitizen, async (request, response) => {
  const { resources, reports } = request.app.locals;
  const [resourceTotals, healthSummary, citizenCount] = await Promise.all([
    resources.aggregate([
      { $match: { status: 'open' } },
      {
        $group: {
          _id: { category: '$category', type: '$type' },
          quantity: { $sum: '$quantity' },
          listings: { $sum: 1 }
        }
      }
    ]).toArray(),
    buildHealthSummary(reports),
    request.app.locals.users.countDocuments()
  ]);
  return response.json({ resourceTotals, healthSummary, citizenCount });
});

app.get('/api/resources', requireCitizen, async (request, response) => {
  const entries = await request.app.locals.resources.find({ status: 'open' })
    .sort({ createdAt: -1 })
    .limit(50)
    .project({ _id: 1, type: 1, category: 1, quantity: 1, level: 1, note: 1, authorId: 1, authorName: 1, createdAt: 1 })
    .toArray();
  return response.json({
    entries: entries.map(({ _id, ...entry }) => ({ ...entry, id: String(_id) }))
  });
});

app.post('/api/resources', requireCitizen, async (request, response) => {
  const { type, category, quantity, level, note = '' } = request.body || {};
  if (!['offer', 'request'].includes(type)) {
    return response.status(400).json({ error: 'Choose offer or request.' });
  }
  if (!['power', 'water', 'food'].includes(category)) {
    return response.status(400).json({ error: 'Choose power, water, or food.' });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
    return response.status(400).json({ error: 'Enter an amount between 1 and 100,000.' });
  }
  if (!validLevel(level)) {
    return response.status(400).json({ error: 'Choose a level between 1 and 99.' });
  }
  if (note !== '' && !validText(note, 240)) {
    return response.status(400).json({ error: 'Notes must be 240 characters or fewer.' });
  }

  const entry = {
    type,
    category,
    quantity,
    level,
    note: note.trim(),
    authorId: request.citizen.id,
    authorName: request.citizen.name,
    status: 'open',
    createdAt: new Date()
  };
  const result = await request.app.locals.resources.insertOne(entry);
  await createNotification(request.app.locals.notifications, {
    type: 'resource',
    title: `${category[0].toUpperCase()}${category.slice(1)} ${type === 'offer' ? 'offered' : 'requested'}`,
    body: `${entry.quantity} ${category} · Level ${level}${entry.note ? ` · ${entry.note}` : ''}`,
    level,
    targetView: 'resources',
    actorId: entry.authorId
  });
  return response.status(201).json({ entry: { ...entry, id: String(result.insertedId) } });
});

app.post('/api/resources/:id/close', requireCitizen, async (request, response) => {
  if (!/^[a-f\d]{24}$/i.test(request.params.id)) {
    return response.status(400).json({ error: 'Invalid listing.' });
  }
  const result = await request.app.locals.resources.updateOne({
    _id: new ObjectId(request.params.id),
    authorId: request.citizen.id,
    status: 'open'
  }, { $set: { status: 'closed', closedAt: new Date() } });
  if (!result.matchedCount) return response.status(404).json({ error: 'Open listing not found.' });
  const listing = await request.app.locals.resources.findOne(
    { _id: new ObjectId(request.params.id) },
    { projection: { level: 1 } }
  );
  await createNotification(request.app.locals.notifications, {
    type: 'resource',
    title: 'Resource listing closed',
    body: `An open listing on Level ${listing.level} was marked complete.`,
    level: listing.level,
    targetView: 'resources',
    actorId: request.citizen.id
  });
  return response.json({ closed: true });
});

app.get('/api/network/posts', requireCitizen, async (request, response) => {
  const posts = await request.app.locals.posts.find({})
    .sort({ createdAt: -1 })
    .limit(50)
    .project({ body: 1, authorName: 1, authorLevel: 1, createdAt: 1 })
    .toArray();
  return response.json({ posts });
});

app.post('/api/network/posts', requireCitizen, async (request, response) => {
  const { body } = request.body || {};
  if (!validText(body, 400)) {
    return response.status(400).json({ error: 'Updates must be between 1 and 400 characters.' });
  }
  const post = {
    body: body.trim(),
    authorId: request.citizen.id,
    authorName: request.citizen.name,
    authorLevel: request.citizen.level,
    createdAt: new Date()
  };
  const result = await request.app.locals.posts.insertOne(post);
  await createNotification(request.app.locals.notifications, {
    type: 'update',
    title: 'Community update',
    body: `${post.authorName}: ${post.body}`,
    targetView: 'network',
    actorId: post.authorId
  });
  return response.status(201).json({ post: { ...post, id: String(result.insertedId) } });
});

app.get('/api/network/help', requireCitizen, async (request, response) => {
  const requests = await request.app.locals.helpRequests.find({ status: 'open' })
    .sort({ createdAt: -1 })
    .limit(50)
    .project({ kind: 1, details: 1, level: 1, authorId: 1, authorName: 1, status: 1, createdAt: 1 })
    .toArray();
  return response.json({
    requests: requests.map(({ _id, ...item }) => ({ ...item, id: String(_id) }))
  });
});

app.post('/api/network/help', requireCitizen, async (request, response) => {
  const { kind, details = '' } = request.body || {};
  if (!['Medical', 'Safety', 'Supplies'].includes(kind)) {
    return response.status(400).json({ error: 'Choose a type of help.' });
  }
  if (details !== '' && !validText(details, 240)) {
    return response.status(400).json({ error: 'Details must be 240 characters or fewer.' });
  }
  const helpRequest = {
    kind,
    details: details.trim(),
    level: request.citizen.level,
    authorId: request.citizen.id,
    authorName: request.citizen.name,
    status: 'open',
    createdAt: new Date()
  };
  const result = await request.app.locals.helpRequests.insertOne(helpRequest);
  await createNotification(request.app.locals.notifications, {
    type: 'help',
    title: `${kind} help request`,
    body: details || `A neighbor on Level ${helpRequest.level} is requesting help.`,
    level: helpRequest.level,
    targetView: 'network',
    actorId: helpRequest.authorId
  });
  return response.status(201).json({ request: { ...helpRequest, id: String(result.insertedId) } });
});

app.post('/api/network/help/:id/close', requireCitizen, async (request, response) => {
  if (!/^[a-f\d]{24}$/i.test(request.params.id)) {
    return response.status(400).json({ error: 'Invalid help request.' });
  }
  const result = await request.app.locals.helpRequests.updateOne({
    _id: new ObjectId(request.params.id),
    authorId: request.citizen.id,
    status: 'open'
  }, { $set: { status: 'closed', closedAt: new Date() } });
  if (!result.matchedCount) return response.status(404).json({ error: 'Open help request not found.' });
  const helpRequest = await request.app.locals.helpRequests.findOne(
    { _id: new ObjectId(request.params.id) },
    { projection: { level: 1 } }
  );
  await createNotification(request.app.locals.notifications, {
    type: 'help',
    title: 'Help request resolved',
    body: `A Level ${helpRequest.level} request was marked resolved.`,
    level: helpRequest.level,
    targetView: 'network',
    actorId: request.citizen.id
  });
  return response.json({ closed: true });
});

const symptomOptions = ['Cough', 'Fever', 'Shortness of breath', 'Chest discomfort', 'Fatigue'];
const supplyOptions = ['Masks', 'Air filters', 'Medicine', 'Oxygen', 'None'];

async function buildHealthSummary(reports) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 6);
  const previousStart = new Date(start);
  previousStart.setUTCDate(previousStart.getUTCDate() - 7);
  const monthStart = new Date();
  monthStart.setUTCDate(monthStart.getUTCDate() - 30);

  const [daily, byLevel, supplyNeeds, symptomCounts, periodCounts] = await Promise.all([
    reports.aggregate([
      { $match: { createdAt: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          reports: { $sum: 1 },
          severe: { $sum: { $cond: [{ $eq: ['$severity', 'Severe'] }, 1, 0] } }
        }
      },
      { $sort: { _id: 1 } }
    ]).toArray(),
    reports.aggregate([
      { $match: { createdAt: { $gte: monthStart } } },
      { $group: { _id: '$level', reports: { $sum: 1 }, severe: { $sum: { $cond: [{ $eq: ['$severity', 'Severe'] }, 1, 0] } } } },
      { $sort: { _id: 1 } }
    ]).toArray(),
    reports.aggregate([
      { $match: { createdAt: { $gte: monthStart }, supplyNeed: { $ne: 'None' } } },
      { $group: { _id: '$supplyNeed', reports: { $sum: 1 } } },
      { $sort: { reports: -1 } }
    ]).toArray(),
    reports.aggregate([
      { $match: { createdAt: { $gte: monthStart } } },
      { $unwind: '$symptoms' },
      { $group: { _id: '$symptoms', reports: { $sum: 1 } } },
      { $sort: { reports: -1 } }
    ]).toArray(),
    reports.aggregate([
      { $match: { createdAt: { $gte: monthStart } } },
      {
        $group: {
          _id: null,
          lastSevenDays: { $sum: { $cond: [{ $gte: ['$createdAt', start] }, 1, 0] } },
          previousSevenDays: { $sum: { $cond: [{ $and: [{ $lt: ['$createdAt', start] }, { $gte: ['$createdAt', previousStart] }] }, 1, 0] } },
          month: { $sum: 1 },
          severe: { $sum: { $cond: [{ $and: [{ $eq: ['$severity', 'Severe'] }, { $gte: ['$createdAt', start] }] }, 1, 0] } }
        }
      }
    ]).toArray()
  ]);

  return {
    daily,
    byLevel: byLevel.map(row => ({ level: row._id, reports: row.reports, severe: row.severe })),
    supplyNeeds: supplyNeeds.map(row => ({ supply: row._id, reports: row.reports })),
    symptomCounts: symptomCounts.map(row => ({ symptom: row._id, reports: row.reports })),
    ...(periodCounts[0] || { lastSevenDays: 0, previousSevenDays: 0, month: 0, severe: 0 })
  };
}

app.get('/api/health/summary', requireCitizen, async (request, response) => {
  return response.json(await buildHealthSummary(request.app.locals.reports));
});

app.post('/api/health/reports', requireCitizen, async (request, response) => {
  const { symptoms, severity, supplyNeed, level } = request.body || {};
  if (!Array.isArray(symptoms) || symptoms.length < 1 || symptoms.length > symptomOptions.length
      || symptoms.some(symptom => !symptomOptions.includes(symptom))
      || new Set(symptoms).size !== symptoms.length) {
    return response.status(400).json({ error: 'Select at least one valid symptom.' });
  }
  if (!['Mild', 'Moderate', 'Severe'].includes(severity)) {
    return response.status(400).json({ error: 'Choose a severity.' });
  }
  if (!supplyOptions.includes(supplyNeed)) {
    return response.status(400).json({ error: 'Choose a supply need.' });
  }
  if (!validLevel(level)) {
    return response.status(400).json({ error: 'Choose a level between 1 and 99.' });
  }

  await request.app.locals.reports.insertOne({
    symptoms,
    severity,
    supplyNeed,
    level,
    createdAt: new Date()
  });
  await createNotification(request.app.locals.notifications, {
    type: 'health',
    title: 'Anonymous health report',
    body: `Community health data was updated for Level ${level}.`,
    level,
    targetView: 'health'
  });
  return response.status(201).json({ recorded: true });
});

app.get('/api/network/map', requireCitizen, async (request, response) => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);
  const { users, resources, helpRequests, reports } = request.app.locals;
  const [citizensByLevel, resourceEntries, helpEntries, healthByLevel] = await Promise.all([
    users.aggregate([
      { $group: { _id: '$level', citizens: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray(),
    resources.find({ status: 'open' })
      .sort({ createdAt: -1 })
      .limit(100)
      .project({ type: 1, category: 1, quantity: 1, level: 1, note: 1, authorId: 1, authorName: 1, createdAt: 1 })
      .toArray(),
    helpRequests.find({ status: 'open' })
      .sort({ createdAt: -1 })
      .limit(100)
      .project({ kind: 1, details: 1, level: 1, authorId: 1, authorName: 1, createdAt: 1 })
      .toArray(),
    reports.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$level',
          reports: { $sum: 1 },
          severe: { $sum: { $cond: [{ $eq: ['$severity', 'Severe'] }, 1, 0] } }
        }
      },
      { $sort: { _id: 1 } }
    ]).toArray()
  ]);
  return response.json({
    citizensByLevel: citizensByLevel.map(row => ({ level: row._id, citizens: row.citizens })),
    resourceEntries: resourceEntries.map(({ _id, ...entry }) => ({ ...entry, id: String(_id) })),
    helpRequests: helpEntries.map(({ _id, ...entry }) => ({ ...entry, id: String(_id) })),
    healthByLevel: healthByLevel.map(row => ({ level: row._id, reports: row.reports, severe: row.severe }))
  });
});

app.get('/api/notifications', requireCitizen, async (request, response) => {
  const citizenId = request.citizen.id;
  const audience = {
    actorId: { $ne: citizenId },
    $or: [{ level: null }, { level: request.citizen.level }]
  };
  const notifications = request.app.locals.notifications;
  const [items, unreadCount] = await Promise.all([
    notifications.find(audience)
      .sort({ createdAt: -1 })
      .limit(50)
      .project({ type: 1, title: 1, body: 1, targetView: 1, createdAt: 1, readBy: 1 })
      .toArray(),
    notifications.countDocuments({ ...audience, readBy: { $ne: citizenId } })
  ]);
  return response.json({
    unreadCount,
    notifications: items.map(({ _id, readBy, ...item }) => ({
      ...item,
      id: String(_id),
      read: readBy.includes(citizenId)
    }))
  });
});

app.post('/api/notifications/read-all', requireCitizen, async (request, response) => {
  const citizenId = request.citizen.id;
  const result = await request.app.locals.notifications.updateMany({
    actorId: { $ne: citizenId },
    $or: [{ level: null }, { level: request.citizen.level }],
    readBy: { $ne: citizenId }
  }, { $addToSet: { readBy: citizenId } });
  return response.json({ markedRead: result.modifiedCount });
});

app.post('/api/notifications/:id/read', requireCitizen, async (request, response) => {
  if (!/^[a-f\d]{24}$/i.test(request.params.id)) {
    return response.status(400).json({ error: 'Invalid notification.' });
  }
  const citizenId = request.citizen.id;
  const result = await request.app.locals.notifications.updateOne({
    _id: new ObjectId(request.params.id),
    actorId: { $ne: citizenId },
    $or: [{ level: null }, { level: request.citizen.level }]
  }, { $addToSet: { readBy: citizenId } });
  if (!result.matchedCount) return response.status(404).json({ error: 'Notification not found.' });
  return response.json({ read: true });
});

app.get('/api/chat/citizens', requireCitizen, async (request, response) => {
  const page = request.query.page === undefined ? 1 : Number(request.query.page);
  const pageSize = 50;
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
    return response.status(400).json({ error: 'Page must be a positive integer.' });
  }
  if (search.length > 80) {
    return response.status(400).json({ error: 'Search must be 80 characters or fewer.' });
  }

  const filter = {
    _id: { $ne: new ObjectId(request.citizen.id) },
    isDemo: { $ne: true }
  };
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const levelMatch = /^level\s+(\d{1,2})$/i.exec(search);
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      ...(levelMatch ? [{ level: Number(levelMatch[1]) }] : [])
    ];
  }

  const users = request.app.locals.users;
  const onlineIds = [...chatConnections.keys()];
  const [citizens, total] = await Promise.all([
    users.aggregate([
      { $match: filter },
      { $addFields: { online: { $in: [{ $toString: '$_id' }, onlineIds] } } },
      { $sort: { online: -1, createdAt: -1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      { $project: { name: 1, level: 1, online: 1 } }
    ]).toArray(),
    users.countDocuments(filter)
  ]);
  return response.json({
    citizens: citizens.map(({ _id, ...citizen }) => ({ ...citizen, id: String(_id) })),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total
  });
});

app.get('/api/citizens', requireCitizen, async (request, response) => {
  const page = request.query.page === undefined ? 1 : Number(request.query.page);
  const pageSize = 50;
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
    return response.status(400).json({ error: 'Page must be a positive integer.' });
  }
  if (search.length > 80) {
    return response.status(400).json({ error: 'Search must be 80 characters or fewer.' });
  }

  const filter = {};
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const levelMatch = /^level\s+(\d{1,2})$/i.exec(search);
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      ...(levelMatch ? [{ level: Number(levelMatch[1]) }] : [])
    ];
  }
  const users = request.app.locals.users;
  const [citizens, total] = await Promise.all([
    users.find(filter)
    .sort({ isDemo: -1, createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .project({ name: 1, level: 1, createdAt: 1, isDemo: 1 })
      .toArray(),
    users.countDocuments(filter)
  ]);
  return response.json({
    citizens,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total
  });
});

app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'index.html')));
app.get('/styles.css', (_request, response) => response.sendFile(path.join(__dirname, 'styles.css')));
app.get('/script.js', (_request, response) => response.sendFile(path.join(__dirname, 'script.js')));
app.use((_request, response) => response.status(404).send('Not found'));
app.use((error, _request, response, _next) => {
  if (error.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Request must contain valid JSON.' });
  }
  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request is too large.' });
  }
  console.error('Request failed:', error);
  return response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  await client.connect();
  const database = client.db(MONGODB_DB || 'deepwell');
  const users = database.collection('citizens');
  await users.createIndex({ email: 1 }, { unique: true });

  app.locals.users = users;
  app.locals.authTokens = database.collection('authTokens');
  app.locals.resources = database.collection('resourceListings');
  app.locals.posts = database.collection('communityPosts');
  app.locals.helpRequests = database.collection('helpRequests');
  app.locals.reports = database.collection('healthReports');
  app.locals.notifications = database.collection('notifications');
  await app.locals.reports.createIndex({ createdAt: 1 });
  await app.locals.authTokens.createIndex({ tokenHash: 1 }, { unique: true });
  await app.locals.authTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await app.locals.notifications.createIndex({ level: 1, createdAt: -1 });
  await app.locals.notifications.createIndex({ 'readBy': 1 });
  configureChatSockets(users);
  httpServer.listen(PORT, () => {
    console.info(`Deepwell is listening on http://localhost:${PORT}`);
  });
}

start().catch(error => {
  console.error('Could not start Deepwell:', error.message);
  process.exitCode = 1;
});
