'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');
const { MongoClient } = require('mongodb');

const { MONGODB_URI, MONGODB_DB } = process.env;
if (!MONGODB_URI) throw new Error('MONGODB_URI is required. Set it in your local .env file.');

const seedVersion = 'deepwell-demo-v1';
const levels = Array.from({ length: 12 }, (_, index) => index + 1);
const firstNames = [
  'Ari', 'Bryn', 'Cleo', 'Dara', 'Elias', 'Farah', 'Gabe', 'Hana', 'Imani', 'Jules',
  'Kai', 'Leona', 'Mika', 'Nadia', 'Oren', 'Priya', 'Quinn', 'Rafi', 'Sana', 'Tomas'
];
const lastNames = [
  'Adebayo', 'Bennett', 'Chen', 'Das', 'Escobar', 'Faruqi', 'Garcia', 'Haddad',
  'Ibrahim', 'Jones', 'Kim', 'Lopez', 'Mensah', 'Nguyen', 'Okafor', 'Patel',
  'Reyes', 'Singh', 'Torres', 'Williams'
];
const symptoms = ['Cough', 'Fever', 'Shortness of breath', 'Chest discomfort', 'Fatigue'];
const supplies = ['Masks', 'Air filters', 'Medicine', 'Oxygen', 'None'];

function daysAgo(days, minutes = 0) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000 - minutes * 60 * 1000);
}

function seededCitizen(index) {
  const firstName = firstNames[index % firstNames.length];
  const lastName = lastNames[Math.floor(index / firstNames.length) % lastNames.length];
  return {
    demoSeedId: `${seedVersion}:citizen:${String(index + 1).padStart(3, '0')}`,
    name: `${firstName} ${lastName}`,
    email: `resident${String(index + 1).padStart(3, '0')}@deepwell.invalid`,
    passwordHash: null,
    level: (index % levels.length) + 1,
    isDemo: true,
    createdAt: daysAgo(90 - (index % 90), index * 7)
  };
}

function makeRows(users) {
  const citizens = users;
  const resources = Array.from({ length: 48 }, (_, index) => {
    const category = ['power', 'water', 'food'][index % 3];
    const type = index % 4 === 0 ? 'request' : 'offer';
    const level = (index % levels.length) + 1;
    return {
      demoSeedId: `${seedVersion}:resource:${String(index + 1).padStart(3, '0')}`,
      type,
      category,
      quantity: category === 'power' ? 4 + index % 18 : category === 'water' ? 8 + index % 34 : 6 + index % 28,
      level,
      note: type === 'offer'
        ? ['Pickup at the relay desk.', 'Available during the evening window.', 'Coordinate at the common room.'][index % 3]
        : ['Household needs a refill.', 'Clinic use prioritized.', 'Pickup requested this shift.'][index % 3],
      authorId: String(citizens[(index * 7) % citizens.length]._id),
      authorName: citizens[(index * 7) % citizens.length].name,
      status: index % 13 === 0 ? 'closed' : 'open',
      createdAt: daysAgo(index % 10, index * 11)
    };
  });

  const posts = Array.from({ length: 24 }, (_, index) => {
    const citizen = citizens[(index * 9 + 3) % citizens.length];
    return {
      demoSeedId: `${seedVersion}:post:${String(index + 1).padStart(3, '0')}`,
      body: [
        'Water relay is open for the next distribution window.',
        'Shared filters are available at the community clinic.',
        'Neighbors are coordinating a meal exchange this evening.',
        'The west stairwell relay is back online.',
        'Please check on anyone who needs help carrying supplies.',
        'Tool and seed exchange meets in the level commons today.'
      ][index % 6],
      authorId: String(citizen._id),
      authorName: citizen.name,
      authorLevel: citizen.level,
      createdAt: daysAgo(index % 8, index * 13)
    };
  });

  const helpRequests = Array.from({ length: 12 }, (_, index) => {
    const citizen = citizens[(index * 11 + 5) % citizens.length];
    return {
      demoSeedId: `${seedVersion}:help:${String(index + 1).padStart(3, '0')}`,
      kind: ['Medical', 'Safety', 'Supplies'][index % 3],
      details: [
        'Need a neighbor to help carry a water refill.',
        'Requesting a mask pickup from the clinic.',
        'Please check the relay near the east stairwell.',
        'Looking for a short-term power bank loan.'
      ][index % 4],
      level: citizen.level,
      authorId: String(citizen._id),
      authorName: citizen.name,
      status: index % 4 === 0 ? 'closed' : 'open',
      createdAt: daysAgo(index % 9, index * 17)
    };
  });

  const reports = Array.from({ length: 42 }, (_, index) => ({
    demoSeedId: `${seedVersion}:health:${String(index + 1).padStart(3, '0')}`,
    symptoms: index % 5 === 0
      ? ['Cough', 'Fever']
      : index % 4 === 0
        ? ['Cough', 'Fatigue']
        : [symptoms[index % symptoms.length]],
    severity: index % 11 === 0 ? 'Severe' : index % 3 === 0 ? 'Moderate' : 'Mild',
    supplyNeed: supplies[index % supplies.length],
    level: (index * 5 % levels.length) + 1,
    createdAt: daysAgo(index % 24, index * 19)
  }));

  const notifications = [
    ...resources.slice(0, 8).map((entry, index) => ({
      demoSeedId: `${seedVersion}:notification:resource:${index + 1}`,
      type: 'resource',
      title: `${entry.category[0].toUpperCase()}${entry.category.slice(1)} ${entry.type === 'offer' ? 'offered' : 'requested'}`,
      body: `${entry.quantity} ${entry.category} · Level ${entry.level}`,
      level: entry.level,
      targetView: 'resources',
      actorId: entry.authorId,
      createdAt: entry.createdAt
    })),
    ...posts.slice(0, 6).map((post, index) => ({
      demoSeedId: `${seedVersion}:notification:update:${index + 1}`,
      type: 'update',
      title: 'Community update',
      body: `${post.authorName}: ${post.body}`,
      targetView: 'network',
      actorId: post.authorId,
      createdAt: post.createdAt
    })),
    ...helpRequests.slice(0, 6).map((item, index) => ({
      demoSeedId: `${seedVersion}:notification:help:${index + 1}`,
      type: 'help',
      title: `${item.kind} help request`,
      body: item.details,
      level: item.level,
      targetView: 'network',
      actorId: item.authorId,
      createdAt: item.createdAt
    })),
    ...reports.slice(0, 6).map((report, index) => ({
      demoSeedId: `${seedVersion}:notification:health:${index + 1}`,
      type: 'health',
      title: 'Anonymous health report',
      body: `Community health data was updated for Level ${report.level}.`,
      level: report.level,
      targetView: 'health',
      createdAt: report.createdAt
    }))
  ];

  return { resources, posts, helpRequests, reports, notifications };
}

async function seedCollection(collection, rows) {
  if (!rows.length) return 0;
  await collection.createIndex({ demoSeedId: 1 }, { unique: true, sparse: true });
  const result = await collection.bulkWrite(rows.map(row => ({
    updateOne: {
      filter: { demoSeedId: row.demoSeedId },
      update: {
        $setOnInsert: {
          ...row,
          ...(row.demoSeedId.includes(':notification:') ? { readBy: [] } : {})
        }
      },
      upsert: true
    }
  })), { ordered: true });
  return result.upsertedCount;
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const database = client.db(MONGODB_DB || 'deepwell');
    const usersCollection = database.collection('citizens');
    await usersCollection.createIndex({ email: 1 }, { unique: true });

    const desiredUsers = Array.from({ length: 100 }, (_, index) => seededCitizen(index));
    const emails = desiredUsers.map(user => user.email);
    const existing = await usersCollection.find({ email: { $in: emails } })
      .project({ email: 1, _id: 1, name: 1, level: 1, demoSeedId: 1 })
      .toArray();
    const existingEmails = new Set(existing.map(user => user.email));
    const newUsers = desiredUsers.filter(user => !existingEmails.has(user.email));
    const hashes = await Promise.all(newUsers.map(() =>
      bcrypt.hash(randomBytes(32).toString('base64url'), 4)
    ));
    newUsers.forEach((user, index) => { user.passwordHash = hashes[index]; });

    if (newUsers.length) {
      await usersCollection.bulkWrite(newUsers.map(user => ({
        updateOne: {
          filter: { email: user.email },
          update: { $setOnInsert: user },
          upsert: true
        }
      })), { ordered: true });
    }

    const citizens = await usersCollection.find({
      demoSeedId: { $regex: `^${seedVersion}:citizen:` }
    }).toArray();
    if (citizens.length < 100) {
      throw new Error(`Expected 100 demo citizens after seeding; found ${citizens.length}.`);
    }

    const seededRows = makeRows(citizens);
    const counts = {
      citizensAdded: newUsers.length,
      resourcesAdded: await seedCollection(database.collection('resourceListings'), seededRows.resources),
      postsAdded: await seedCollection(database.collection('communityPosts'), seededRows.posts),
      helpRequestsAdded: await seedCollection(database.collection('helpRequests'), seededRows.helpRequests),
      healthReportsAdded: await seedCollection(database.collection('healthReports'), seededRows.reports),
      notificationsAdded: await seedCollection(database.collection('notifications'), seededRows.notifications)
    };
    console.info('Deepwell demo data is ready:', JSON.stringify(counts));
    console.info('Demo accounts are directory fixtures only and cannot sign in.');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error('Could not seed Deepwell demo data:', error.message);
  process.exitCode = 1;
});
