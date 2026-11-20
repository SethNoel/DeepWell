const toast = document.getElementById('toast');
const authScreen = document.getElementById('authScreen');
const appShell = document.getElementById('appShell');
const authForm = document.getElementById('authForm');
const authMessage = document.getElementById('authMessage');
const registerFields = document.getElementById('registerFields');
const authName = document.getElementById('authName');
const authLevel = document.getElementById('authLevel');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authSubmit = document.getElementById('authSubmit');
const passwordHint = document.getElementById('passwordHint');
let authMode = 'login';
let notificationTimer;
let chatSocket;
let activeChatView = null;
let selectedChat = null;
let chatPresence = new Set();
const chatUnreadCounts = new Map();
const accessTokenStorageKey = 'deepwell.accessToken';

function getAccessToken() {
  return sessionStorage.getItem(accessTokenStorageKey);
}

function updateChatPresence(citizenId, online) {
  if (online) chatPresence.add(citizenId);
  else chatPresence.delete(citizenId);
  if (activeChatView) {
    renderChatPeople();
    if (selectedChat && selectedChat.id === citizenId) updateActiveChatHeader();
  }
}

function updateChatConnectionStatus(connected) {
  if (!connected) chatPresence.clear();
  if (activeChatView?.selfStatus) {
    activeChatView.selfStatus.textContent = connected ? 'You · Online' : 'You · Reconnecting';
    activeChatView.selfStatus.className = `chat-self-status${connected ? ' chat-online' : ' chat-offline'}`;
  }
  if (activeChatView) {
    renderChatPeople();
    updateActiveChatHeader();
  }
}

function emitChatRequest(eventName, payload) {
  return new Promise((resolve, reject) => {
    if (!chatSocket?.connected) {
      reject(new Error('Chat is reconnecting. Please try again in a moment.'));
      return;
    }
    chatSocket.timeout(10000).emit(eventName, payload, (timeoutError, result) => {
      if (timeoutError) {
        reject(new Error('The chat server did not respond. Please try again.'));
      } else if (result?.error) {
        reject(new Error(result.error));
      } else {
        resolve(result);
      }
    });
  });
}

function startChatConnection() {
  closeChatConnection();
  chatPresence.clear();
  chatSocket = io({ auth: { accessToken: getAccessToken() } });
  chatSocket.on('connect', () => {
    updateChatConnectionStatus(true);
    if (selectedChat && currentView === 'chats' && activeChatView) selectChat(selectedChat);
  });
  chatSocket.on('connect_error', () => updateChatConnectionStatus(false));
  chatSocket.on('disconnect', () => updateChatConnectionStatus(false));
  chatSocket.on('presence_snapshot', snapshot => {
    chatPresence = new Set(snapshot.onlineIds);
    if (activeChatView) {
      renderChatPeople();
      updateActiveChatHeader();
    }
  });
  chatSocket.on('presence', presence => {
    updateChatPresence(presence.citizenId, presence.online);
  });
  chatSocket.on('chat:message', ({ peerId, message }) => {
    if (selectedChat && selectedChat.id === peerId && currentView === 'chats') {
      chatUnreadCounts.delete(peerId);
      activeChatView.pendingMessages.push(message);
      appendChatMessage(message);
      renderChatPeople();
    } else if (message.senderId !== currentCitizen.id) {
      chatUnreadCounts.set(peerId, (chatUnreadCounts.get(peerId) || 0) + 1);
      renderChatPeople();
    }
  });
}

function closeChatConnection() {
  if (chatSocket) {
    chatSocket.disconnect();
    chatSocket = null;
  }
}

function setAuthenticated(citizen) {
  if (currentCitizen && currentCitizen.id !== citizen.id) {
    selectedChat = null;
    chatUnreadCounts.clear();
    chatPresence.clear();
  }
  currentCitizen = citizen;
  authScreen.hidden = true;
  appShell.hidden = false;
  document.getElementById('citizenName').textContent = citizen.name;
  document.getElementById('citizenLevel').textContent = `Level ${citizen.level} · Citizen`;
  document.getElementById('citizenFirstName').textContent = citizen.name.trim().split(/\s+/)[0];
  document.querySelector('.avatar').textContent = citizen.name.trim().split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('sidebarCitizenCount').textContent = '…';
  startChatConnection();
  loadOverview();
  refreshNotifications();
  clearInterval(notificationTimer);
  notificationTimer = setInterval(refreshNotifications, 60000);
}

async function loadSession() {
  try {
    const response = await fetch('/api/auth/session', {
      headers: getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}
    });
    if (response.status === 401) {
      sessionStorage.removeItem(accessTokenStorageKey);
      return;
    }
    if (!response.ok) throw new Error('Session check failed');
    const data = await response.json();
    if (data.authenticated) setAuthenticated(data.citizen);
  } catch {
    authMessage.textContent = 'Could not reach the sign-in server. Check that the app is running.';
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.getElementById('authTitle').textContent = registering ? 'Join the network' : 'Welcome back';
  document.querySelector('.auth-description').textContent = registering
    ? 'Create a citizen account to connect with your community.'
    : 'Sign in to your citizen account to access the community network.';
  document.getElementById('switchText').textContent = registering ? 'Already have an account?' : 'New to the network?';
  document.getElementById('switchAuthMode').textContent = registering ? 'Sign in' : 'Create an account';
  authSubmit.textContent = registering ? 'Create account' : 'Sign in';
  registerFields.hidden = !registering;
  authName.required = registering;
  authLevel.required = registering;
  authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  authPassword.minLength = registering ? 10 : 1;
  passwordHint.hidden = !registering;
  authMessage.textContent = '';
}

document.getElementById('switchAuthMode').addEventListener('click', () => {
  setAuthMode(authMode === 'login' ? 'register' : 'login');
});

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  authMessage.textContent = '';
  authSubmit.disabled = true;
  try {
    const payload = {
      email: authEmail.value.trim(),
      password: authPassword.value
    };
    if (authMode === 'register') {
      payload.name = authName.value.trim();
      payload.level = Number(authLevel.value);
    }
    const response = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      authMessage.textContent = data.error || 'Unable to sign in. Please try again.';
      return;
    }
    sessionStorage.setItem(accessTokenStorageKey, data.accessToken);
    setAuthenticated(data.citizen);
  } catch {
    authMessage.textContent = 'Could not reach the sign-in server. Please try again.';
  } finally {
    authSubmit.disabled = false;
  }
});

document.getElementById('signOutButton').addEventListener('click', async () => {
  closeChatConnection();
  try {
    const accessToken = getAccessToken();
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
    });
    if (!response.ok) throw new Error('Sign out failed');
    sessionStorage.removeItem(accessTokenStorageKey);
    appShell.hidden = true;
    authScreen.hidden = false;
    authForm.reset();
    setAuthMode('login');
    authEmail.focus();
    clearInterval(notificationTimer);
    currentCitizen = null;
    selectedChat = null;
    chatUnreadCounts.clear();
    chatPresence.clear();
    updateChatNavCount();
  } catch {
    if (currentCitizen) startChatConnection();
    showToast('Could not sign out. Please try again.');
  }
});

window.addEventListener('beforeunload', closeChatConnection);

loadSession();

function showToast(message) {
  toast.querySelector('p').textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

const overviewView = document.getElementById('overviewView');
const tabView = document.getElementById('tabView');
let currentCitizen = null;
let currentView = 'overview';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function append(parent, ...children) {
  children.forEach(child => parent.append(child));
  return parent;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
      ...options.headers
    }
  });
  if (response.status === 401) {
    sessionStorage.removeItem(accessTokenStorageKey);
    closeChatConnection();
    appShell.hidden = true;
    authScreen.hidden = false;
    authMessage.textContent = 'Please sign in again to continue.';
    clearInterval(notificationTimer);
    currentCitizen = null;
    selectedChat = null;
    chatUnreadCounts.clear();
    chatPresence.clear();
    activeChatView = null;
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'The request could not be completed.');
  }
  if (response.status === 204) return null;
  return response.json();
}

async function refreshNotifications(showErrors = false) {
  if (!currentCitizen) return;
  try {
    const data = await api('/api/notifications');
    const badge = document.getElementById('notificationCount');
    badge.hidden = data.unreadCount === 0;
    badge.textContent = data.unreadCount > 99 ? '99+' : String(data.unreadCount);
    document.getElementById('notificationButton').setAttribute(
      'aria-label',
      data.unreadCount ? `Notifications, ${data.unreadCount} unread` : 'Notifications'
    );
    if (!document.getElementById('notificationsDialog').open) return;
    renderNotifications(data);
  } catch (error) {
    if (showErrors) showToast(error.message);
  }
}

function renderNotifications(data) {
  const list = document.getElementById('notificationList');
  const summary = document.getElementById('notificationSummary');
  const markAll = document.getElementById('markAllRead');
  summary.textContent = data.unreadCount
    ? `${data.unreadCount} unread`
    : 'You’re all caught up';
  markAll.disabled = data.unreadCount === 0;
  list.replaceChildren();
  if (!data.notifications.length) {
    list.append(node('p', 'empty-state', 'No notifications yet. Community updates and requests will appear here.'));
    return;
  }
  data.notifications.forEach(item => {
    const button = node('button', `notification-item${item.read ? '' : ' unread'}`);
    button.type = 'button';
    const copy = node('span', 'notification-copy');
    append(
      copy,
      node('strong', '', item.title),
      node('span', '', item.body),
      node('small', '', `${timeAgo(item.createdAt)} · ${item.targetView}`)
    );
    append(button, node('span', 'notification-state', item.read ? 'Read' : 'New'), copy);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/notifications/${item.id}/read`, { method: 'POST' });
        document.getElementById('notificationsDialog').close();
        document.getElementById('notificationButton').setAttribute('aria-expanded', 'false');
        switchView(item.targetView);
        await refreshNotifications();
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    });
    list.append(button);
  });
}

const notificationsDialog = document.getElementById('notificationsDialog');
document.getElementById('notificationButton').addEventListener('click', async () => {
  notificationsDialog.showModal();
  document.getElementById('notificationButton').setAttribute('aria-expanded', 'true');
  await refreshNotifications(true);
});
document.getElementById('closeNotifications').addEventListener('click', () => {
  notificationsDialog.close();
  document.getElementById('notificationButton').setAttribute('aria-expanded', 'false');
});
notificationsDialog.addEventListener('close', () => {
  document.getElementById('notificationButton').setAttribute('aria-expanded', 'false');
});
document.getElementById('markAllRead').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/api/notifications/read-all', { method: 'POST' });
    await refreshNotifications();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

const settingsDialog = document.getElementById('settingsDialog');
const settingsForm = document.getElementById('settingsForm');
const settingsMessage = document.getElementById('settingsMessage');
const settingsName = document.getElementById('settingsName');
const settingsEmail = document.getElementById('settingsEmail');
const settingsLevel = document.getElementById('settingsLevel');
const settingsSubmit = document.getElementById('saveSettings');
const settingsTriggers = [
  document.getElementById('profileSettingsButton'),
  document.getElementById('topSettingsButton')
];

function openSettings() {
  if (!currentCitizen) return;
  settingsName.value = currentCitizen.name;
  settingsEmail.value = currentCitizen.email;
  settingsLevel.value = String(currentCitizen.level);
  settingsMessage.textContent = '';
  settingsMessage.classList.remove('is-error');
  settingsDialog.showModal();
  settingsTriggers.forEach(button => button.setAttribute('aria-expanded', 'true'));
  settingsName.focus();
}

settingsTriggers.forEach(button => button.addEventListener('click', openSettings));
function closeSettings() {
  settingsDialog.close();
  settingsTriggers.forEach(button => button.setAttribute('aria-expanded', 'false'));
}
document.getElementById('closeSettings').addEventListener('click', closeSettings);
document.getElementById('cancelSettings').addEventListener('click', closeSettings);
settingsDialog.addEventListener('close', () => {
  settingsTriggers.forEach(button => button.setAttribute('aria-expanded', 'false'));
});
settingsDialog.addEventListener('click', event => {
  if (event.target === settingsDialog) closeSettings();
});
settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  settingsSubmit.disabled = true;
  settingsMessage.textContent = '';
  settingsMessage.classList.remove('is-error');
  try {
    const data = await api('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        name: settingsName.value.trim(),
        email: settingsEmail.value.trim(),
        level: Number(settingsLevel.value)
      })
    });
    setAuthenticated(data.citizen);
    closeSettings();
    showToast('Account settings saved');
  } catch (error) {
    settingsMessage.textContent = error.message;
    settingsMessage.classList.add('is-error');
  } finally {
    settingsSubmit.disabled = false;
  }
});

function pageHeader(kicker, title, description) {
  const header = node('div', 'page-heading');
  append(header, node('p', 'eyebrow', kicker), node('h2', '', title), node('p', 'page-description', description));
  return header;
}

function panel(title, description) {
  const section = node('section', 'tab-panel');
  const header = node('div', 'tab-panel-header');
  append(header, node('h3', '', title), node('p', '', description));
  section.append(header);
  return section;
}

function field(labelText, control) {
  const wrapper = node('label', 'form-field');
  wrapper.append(node('span', '', labelText), control);
  return wrapper;
}

function textInput(name, options = {}) {
  const input = node(options.multiline ? 'textarea' : 'input', options.multiline ? 'field-control field-textarea' : 'field-control');
  input.name = name;
  if (options.multiline) {
    input.rows = options.rows || 3;
    input.maxLength = options.maxLength || 240;
    input.placeholder = options.placeholder || '';
    input.required = options.required !== false;
  } else {
    input.type = options.type || 'text';
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    if (options.value !== undefined) input.value = String(options.value);
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.required !== false) input.required = true;
  }
  return input;
}

function selectInput(name, choices, value) {
  const select = node('select', 'field-control');
  select.name = name;
  choices.forEach(([optionValue, label]) => {
    const option = node('option', '', label);
    option.value = optionValue;
    select.append(option);
  });
  if (value) select.value = value;
  return select;
}

function submitMessage() {
  return node('p', 'form-message');
}

function setFormMessage(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('is-error', error);
}

function wireJsonForm(form, path, makePayload, onSaved, messageElement) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    setFormMessage(messageElement, '');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(makePayload(new FormData(form))) });
      form.reset();
      if (form.elements.level) form.elements.level.value = String(currentCitizen.level);
      setFormMessage(messageElement, 'Saved to the community network.');
      await onSaved();
    } catch (error) {
      setFormMessage(messageElement, error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
}

function switchView(name) {
  const navButton = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (!navButton) return;
  currentView = name;
  document.querySelectorAll('.nav-item').forEach(item => {
    const active = item === navButton;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });
  const label = navButton.textContent.trim();
  const title = document.querySelector('.title-group h1');
  const kicker = document.querySelector('.title-group p');
  overviewView.hidden = name !== 'overview';
  tabView.hidden = name === 'overview';
  if (name === 'overview') {
    title.textContent = `Welcome, ${currentCitizen ? currentCitizen.name.trim().split(/\s+/)[0] : 'citizen'}`;
    kicker.textContent = 'COMMUNITY OVERVIEW';
    loadOverview();
    return;
  }
  title.textContent = label;
  kicker.textContent = 'DEEPWELL CIVIC NETWORK';
  renderTab(name);
}

document.querySelectorAll('.nav-item').forEach(button => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

document.addEventListener('click', event => {
  const link = event.target.closest('[data-open-view]');
  if (link) switchView(link.dataset.openView);
});

async function loadOverview() {
  if (!currentCitizen) return;
  try {
    const data = await api('/api/overview');
    const totals = new Map(data.resourceTotals.map(row => [`${row._id.category}:${row._id.type}`, row]));
    [['power', 'powerMetric'], ['water', 'waterMetric'], ['food', 'foodMetric']].forEach(([category, id]) => {
      const offered = totals.get(`${category}:offer`);
      const requested = totals.get(`${category}:request`);
      const offerQuantity = offered ? offered.quantity : 0;
      const requestQuantity = requested ? requested.quantity : 0;
      document.getElementById(id).textContent = offerQuantity.toLocaleString();
      document.getElementById(`${category}Requests`).textContent = requestQuantity.toLocaleString();
      document.getElementById(`${category}Progress`).style.width = `${offerQuantity + requestQuantity ? Math.round(100 * offerQuantity / (offerQuantity + requestQuantity)) : 0}%`;
    });
    const health = data.healthSummary;
    document.getElementById('overviewCases').textContent = health.month.toLocaleString();
    const trend = document.getElementById('overviewHealthTrend');
    const rising = health.lastSevenDays > health.previousSevenDays;
    trend.textContent = rising ? 'Rising' : 'Steady';
    trend.parentElement.classList.toggle('trend-rising', rising);
    const daily = new Map(health.daily.map(row => [row._id, row.reports]));
    const values = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - offset);
      values.push({ date, count: daily.get(date.toISOString().slice(0, 10)) || 0 });
    }
    const maximum = Math.max(1, ...values.map(item => item.count));
    const points = values.map((item, index) => {
      const x = Math.round(index * 420 / (values.length - 1));
      const y = Math.round(104 - item.count / maximum * 76);
      return { x, y };
    });
    const linePath = points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
    document.getElementById('overviewHealthLine').setAttribute('d', linePath);
    document.getElementById('overviewHealthArea').setAttribute('d', `${linePath} L420 120 L0 120Z`);
    const labels = document.getElementById('overviewHealthLabels');
    labels.replaceChildren();
    values.forEach((item, index) => {
      labels.append(node('span', '', index === values.length - 1
        ? 'TODAY'
        : item.date.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }).toUpperCase()));
    });
    document.getElementById('sidebarCitizenCount').textContent = data.citizenCount.toLocaleString();
    const updates = await api('/api/network/posts');
    const list = document.getElementById('overviewUpdates');
    list.replaceChildren();
    if (!updates.posts.length) {
      list.append(node('p', 'empty-state', 'No community updates yet. Share the first update in Network.'));
    } else {
      updates.posts.slice(0, 3).forEach(post => list.append(makeUpdate(post)));
    }
  } catch (error) {
    if (currentView === 'overview') showToast(error.message);
  }
}

function initials(name) {
  return name.trim().split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
}

function timeAgo(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function makeUpdate(post) {
  const item = node('article', 'update');
  const avatar = node('div', 'update-avatar green', initials(post.authorName));
  const copy = node('div');
  const meta = node('div', 'update-meta');
  append(meta, node('strong', '', post.authorName), node('span', '', timeAgo(post.createdAt)));
  append(copy, meta, node('p', '', post.body));
  return append(item, avatar, copy);
}

async function renderTab(name) {
  tabView.replaceChildren();
  activeChatView = null;
  if (name === 'resources') return renderResources();
  if (name === 'network') return renderNetwork();
  if (name === 'chats') return renderChat();
  if (name === 'health') return renderHealth();
  if (name === 'citizens') return renderCitizens();
}

function updateChatNavCount() {
  const count = [...chatUnreadCounts.values()].reduce((total, unread) => total + unread, 0);
  const badge = document.getElementById('chatNavCount');
  badge.hidden = count === 0;
  badge.textContent = count > 9 ? '9+' : String(count);
}

function renderChatPeople() {
  updateChatNavCount();
  if (!activeChatView) return;
  const { people, list, count } = activeChatView;
  list.replaceChildren();
  const onlineCount = people.filter(person => chatPresence.has(person.id)).length;
  count.textContent = `${onlineCount} online · ${people.length} shown`;
  if (!people.length) {
    list.append(node('p', 'empty-state', 'No other registered citizens match your search.'));
  }
  people.forEach(person => {
    const online = chatPresence.has(person.id);
    const button = node('button', `chat-person${selectedChat?.id === person.id ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedChat?.id === person.id));
    const unread = chatUnreadCounts.get(person.id) || 0;
    button.setAttribute('aria-label', `Chat with ${person.name}, ${online ? 'online' : 'offline'}${unread ? `, ${unread} unread` : ''}`);
    const avatar = node('span', 'chat-avatar', initials(person.name));
    const copy = node('span', 'chat-person-copy');
    const status = node('small', online ? 'chat-online' : 'chat-offline', online ? 'Online' : `Level ${person.level} · Offline`);
    append(copy, node('strong', '', person.name), status);
    append(button, avatar, copy);
    if (unread) button.append(node('span', 'chat-unread', unread > 9 ? '9+' : String(unread)));
    button.addEventListener('click', () => selectChat(person));
    list.append(button);
  });
  updateActiveChatHeader();
}

function updateActiveChatHeader() {
  if (!activeChatView) return;
  const { title, status, form } = activeChatView;
  if (!selectedChat) {
    title.textContent = 'Choose a citizen';
    status.textContent = 'Select someone to start a private chat.';
    status.className = 'chat-contact-status';
    form.hidden = true;
    return;
  }
  title.textContent = selectedChat.name;
  const online = chatPresence.has(selectedChat.id);
  status.textContent = online ? 'Online now' : `Level ${selectedChat.level} · Offline`;
  status.className = `chat-contact-status${online ? ' chat-online' : ' chat-offline'}`;
  form.hidden = false;
}

function appendChatMessage(message) {
  if (!activeChatView || !selectedChat || activeChatView.renderedMessages.has(message.id)) return;
  activeChatView.renderedMessages.add(message.id);
  const mine = message.senderId === currentCitizen.id;
  const item = node('article', `chat-message${mine ? ' mine' : ''}`);
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (activeChatView.messages.querySelector('.chat-empty')) activeChatView.messages.replaceChildren();
  append(item, node('p', '', message.text), node('small', '', `${mine ? 'You' : selectedChat.name} · ${time}`));
  activeChatView.messages.append(item);
  activeChatView.messages.scrollTop = activeChatView.messages.scrollHeight;
}

async function selectChat(person) {
  selectedChat = person;
  chatUnreadCounts.delete(person.id);
  if (!activeChatView) return;
  activeChatView.layout.classList.add('has-selection');
  activeChatView.renderedMessages.clear();
  activeChatView.pendingMessages = [];
  activeChatView.messages.replaceChildren(node('p', 'empty-state', 'Loading messages…'));
  renderChatPeople();
  try {
    const data = await emitChatRequest('chat:history', { recipientId: person.id });
    if (!selectedChat || selectedChat.id !== person.id || !activeChatView) return;
    activeChatView.messages.replaceChildren();
    activeChatView.renderedMessages.clear();
    if (!data.messages.length) {
      activeChatView.messages.append(node('p', 'chat-empty', 'No messages yet. Send a note to start the conversation.'));
    }
    data.messages.forEach(appendChatMessage);
    activeChatView.pendingMessages.forEach(appendChatMessage);
  } catch (error) {
    if (selectedChat?.id === person.id && activeChatView) {
      activeChatView.messages.replaceChildren(node('p', 'empty-state is-error', error.message));
    }
  }
}

async function renderChat() {
  tabView.replaceChildren(pageHeader(
    'COMMUNITY MESH',
    'Direct chats',
    'See which registered citizens are online and message them directly. Chats are temporary and clear when the server restarts.'
  ));
  const layout = node('section', 'chat-layout');
  const directory = node('div', 'chat-directory');
  const directoryHead = node('div', 'chat-directory-head');
  const identity = node('div', 'chat-directory-identity');
  const directoryTitle = node('h3', '', 'Citizens');
  const selfStatus = node('p', 'chat-self-status chat-offline', 'You · Reconnecting');
  selfStatus.setAttribute('aria-live', 'polite');
  const count = node('p', 'chat-directory-count', 'Loading citizens…');
  append(identity, directoryTitle, selfStatus);
  append(directoryHead, identity, count);
  const search = textInput('chatSearch', { required: false, placeholder: 'Find a citizen' });
  search.setAttribute('aria-label', 'Search citizens to chat with');
  search.setAttribute('autocomplete', 'off');
  search.setAttribute('maxlength', '80');
  const list = node('div', 'chat-people-list');
  const more = node('button', 'text-button chat-load-more', 'Load more citizens');
  more.type = 'button';
  more.hidden = true;
  append(directory, directoryHead, search, list, more);

  const conversation = node('section', 'chat-conversation');
  conversation.setAttribute('aria-label', 'Chat conversation');
  const contact = node('header', 'chat-contact');
  const back = node('button', 'chat-back', '← People');
  back.type = 'button';
  back.addEventListener('click', () => {
    selectedChat = null;
    layout.classList.remove('has-selection');
    renderChatPeople();
  });
  const title = node('strong', '', 'Choose a citizen');
  const status = node('p', 'chat-contact-status', 'Select someone to start a private chat.');
  const contactCopy = node('div', 'chat-contact-copy');
  append(contactCopy, title, status);
  append(contact, back, contactCopy);
  const messages = node('div', 'chat-messages');
  messages.setAttribute('aria-live', 'polite');
  messages.setAttribute('aria-label', 'Messages');
  const form = node('form', 'chat-compose');
  const input = document.createElement('textarea');
  input.className = 'field-control chat-message-input';
  input.name = 'message';
  input.placeholder = 'Write a message…';
  input.setAttribute('aria-label', 'Write a message');
  input.maxLength = 1000;
  input.rows = 2;
  input.required = true;
  const send = node('button', 'primary-button', 'Send');
  send.type = 'submit';
  const feedback = node('p', 'chat-feedback');
  feedback.setAttribute('role', 'status');
  append(form, input, send, feedback);
  form.hidden = true;
  append(conversation, contact, messages, form);
  append(layout, directory, conversation);
  tabView.append(layout);

  activeChatView = { people: [], list, count, title, status, selfStatus, form, messages, layout, renderedMessages: new Set(), pendingMessages: [] };
  updateChatConnectionStatus(Boolean(chatSocket?.connected));
  updateChatNavCount();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const recipient = selectedChat;
    const text = input.value.trim();
    if (!recipient || !text) return;
    send.disabled = true;
    feedback.textContent = '';
    feedback.classList.remove('is-error');
    try {
      const data = await emitChatRequest('chat:send', { recipientId: recipient.id, text });
      if (selectedChat?.id === recipient.id && activeChatView) {
        if (activeChatView.messages.querySelector('.chat-empty')) activeChatView.messages.replaceChildren();
        appendChatMessage(data.message);
        input.value = '';
      }
    } catch (error) {
      feedback.textContent = error.message;
      feedback.classList.add('is-error');
    } finally {
      send.disabled = false;
    }
  });

  let page = 1;
  let hasMore = false;
  let loading = false;
  let requestVersion = 0;
  let query = '';
  async function loadPeople(reset = false) {
    if (loading && !reset) return;
    const version = ++requestVersion;
    loading = true;
    more.disabled = true;
    if (reset) {
      page = 1;
      activeChatView.people = [];
      list.replaceChildren();
    }
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set('search', query);
      const data = await api(`/api/chat/citizens?${params}`);
      if (version !== requestVersion || !activeChatView) return;
      activeChatView.people.push(...data.citizens);
      data.citizens.forEach(person => {
        if (person.online) chatPresence.add(person.id);
        else chatPresence.delete(person.id);
      });
      hasMore = data.hasMore;
      page += 1;
      renderChatPeople();
      const latest = activeChatView.people.find(person => person.id === selectedChat?.id);
      if (latest) selectedChat = latest;
      updateActiveChatHeader();
    } catch (error) {
      if (version === requestVersion && activeChatView) {
        list.replaceChildren(node('p', 'empty-state is-error', error.message));
        count.textContent = '';
      }
    } finally {
      if (version === requestVersion) {
        loading = false;
        more.hidden = !hasMore;
        more.disabled = false;
        more.textContent = hasMore ? 'Load more citizens' : 'All citizens loaded';
      }
    }
  }

  more.addEventListener('click', () => loadPeople());
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    query = search.value.trim();
    searchTimer = setTimeout(() => loadPeople(true), 220);
  });
  await loadPeople(true);
  if (selectedChat && activeChatView.people.some(person => person.id === selectedChat.id)) {
    selectedChat = activeChatView.people.find(person => person.id === selectedChat.id);
    renderChatPeople();
    await selectChat(selectedChat);
  }
}

const svgNamespace = 'http://www.w3.org/2000/svg';

function svgElement(tag, attributes = {}, text) {
  const element = document.createElementNS(svgNamespace, tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
  if (text !== undefined) element.textContent = text;
  return element;
}

function drawLevelMap(svg, mapData, level, filters, details) {
  svg.replaceChildren();
  const floor = Number(level);
  const citizens = mapData.citizensByLevel.find(item => item.level === floor)?.citizens || 0;
  const floorResources = mapData.resourceEntries.filter(item => item.level === floor);
  const floorHelp = mapData.helpRequests.filter(item => item.level === floor);
  const floorHealth = mapData.healthByLevel.find(item => item.level === floor);

  svg.append(
    svgElement('rect', { x: 18, y: 25, width: 764, height: 310, rx: 18, class: 'map-outline' }),
    svgElement('path', { d: 'M35 126 H765 M35 235 H765 M230 27 V124 M420 127 V233 M610 237 V333', class: 'map-corridor' }),
    svgElement('text', { x: 35, y: 20, class: 'map-floor-title' }, `LEVEL ${String(floor).padStart(2, '0')} · ${citizens} CITIZENS`)
  );

  const relays = [
    { name: 'Power junction', x: 130, y: 75, icon: 'P' },
    { name: 'Water relay', x: 330, y: 75, icon: 'W' },
    { name: 'Community clinic', x: 530, y: 75, icon: '+' },
    { name: 'Common room', x: 700, y: 75, icon: 'C' }
  ];
  relays.forEach(relay => {
    const group = svgElement('g', {
      class: 'map-relay',
      role: 'img',
      'aria-label': `${relay.name}, Level ${floor}`
    });
    group.append(
      svgElement('rect', { x: relay.x - 16, y: relay.y - 16, width: 32, height: 32, rx: 8 }),
      svgElement('text', { x: relay.x, y: relay.y + 4, 'text-anchor': 'middle', class: 'relay-symbol' }, relay.icon),
      svgElement('text', { x: relay.x, y: relay.y + 29, 'text-anchor': 'middle', class: 'relay-label' }, relay.name)
    );
    svg.append(group);
  });

  const markers = [];
  if (filters.resources) {
    const groups = new Map();
    floorResources.forEach(entry => {
      const key = `${entry.category}:${entry.type}`;
      const group = groups.get(key) || { category: entry.category, type: entry.type, count: 0, quantity: 0 };
      group.count++;
      group.quantity += entry.quantity;
      groups.set(key, group);
    });
    groups.forEach(group => markers.push({
      kind: 'resource',
      label: `${group.category} ${group.type === 'offer' ? 'offers' : 'requests'}`,
      description: `${group.count} ${group.type === 'offer' ? 'open offers' : 'open requests'} · ${group.quantity.toLocaleString()} ${resourceUnits[group.category]}`,
      targetView: 'resources',
      className: 'resource-marker'
    }));
  }
  if (filters.help) {
    const groups = new Map();
    floorHelp.forEach(item => groups.set(item.kind, (groups.get(item.kind) || 0) + 1));
    groups.forEach((count, kind) => markers.push({
      kind: 'help',
      label: `${kind} help`,
      description: `${count} open ${kind.toLowerCase()} ${count === 1 ? 'request' : 'requests'} on Level ${floor}`,
      targetView: 'network',
      className: 'help-marker'
    }));
  }
  if (filters.health && floorHealth) {
    markers.push({
      kind: 'health',
      label: 'Health reports',
      description: `${floorHealth.reports} anonymous reports in the last 30 days · ${floorHealth.severe} severe reports`,
      targetView: 'health',
      className: 'health-marker'
    });
  }

  markers.forEach((marker, index) => {
    const x = 130 + (index % 5) * 145;
    const y = 172 + Math.floor(index / 5) * 72;
    const group = svgElement('g', {
      class: `map-marker ${marker.className}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${marker.label}: ${marker.description}`
    });
    group.append(
      svgElement('circle', { cx: x, cy: y, r: 15 }),
      svgElement('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'map-marker-symbol' }, marker.kind === 'resource' ? 'R' : marker.kind === 'help' ? '!' : 'H'),
      svgElement('text', { x, y: y + 29, 'text-anchor': 'middle', class: 'map-marker-label' }, marker.label)
    );
    const activate = () => {
      details.replaceChildren(
        node('strong', '', marker.label),
        node('span', '', `Level ${floor} · ${marker.description}`)
      );
      const open = node('button', 'text-button', 'Open details');
      open.type = 'button';
      open.addEventListener('click', () => switchView(marker.targetView), { once: true });
      details.append(open);
    };
    group.addEventListener('click', activate);
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
    svg.append(group);
  });

  details.replaceChildren(node(
    'span',
    'map-help-text',
    markers.length
      ? 'Select a map marker for local activity details.'
      : 'No activity in the selected layers on this level. Relay stations are shown for orientation.'
  ));
}

function makeResourceEntry(entry) {
  const article = node('article', 'data-row');
  const copy = node('div', 'row-copy');
  const heading = node('div', 'row-heading');
  const type = node('span', `type-tag ${entry.type}`, entry.type === 'offer' ? 'Offering' : 'Requesting');
  append(heading, type, node('strong', '', `${entry.quantity.toLocaleString()} ${resourceUnits[entry.category]} ${entry.category}`));
  append(copy, heading, node('p', '', `Level ${entry.level} · ${entry.authorName}${entry.note ? ` · ${entry.note}` : ''}`), node('small', '', timeAgo(entry.createdAt)));
  article.append(copy);
  if (entry.authorId === currentCitizen.id) {
    const close = node('button', 'text-button', 'Close');
    close.type = 'button';
    close.addEventListener('click', async () => {
      close.disabled = true;
      try {
        await api(`/api/resources/${entry.id}/close`, { method: 'POST' });
        await renderResources();
      } catch (error) {
        showToast(error.message);
        close.disabled = false;
      }
    });
    article.append(close);
  }
  return article;
}

const resourceUnits = { power: 'kWh', water: 'litres', food: 'rations' };

async function renderResources() {
  tabView.replaceChildren(pageHeader('RESOURCE DESK', 'Community resource exchange', 'Post a surplus or request what your level needs. Listings are visible to signed-in citizens.'));
  const grid = node('div', 'tab-grid');
  const formPanel = panel('Post a listing', 'Offer supplies or make a request.');
  const form = node('form', 'tab-form');
  const type = selectInput('type', [['offer', 'Offer surplus'], ['request', 'Request supplies']]);
  const category = selectInput('category', [['power', 'Power'], ['water', 'Water'], ['food', 'Food']]);
  const quantity = textInput('quantity', { type: 'number', min: 1, max: 100000, value: 1 });
  const level = textInput('level', { type: 'number', min: 1, max: 99, value: currentCitizen.level });
  const note = textInput('note', { multiline: true, required: false, placeholder: 'Optional pickup or delivery details' });
  const message = submitMessage();
  append(form, field('Listing', type), field('Resource', category), field('Amount', quantity), field('Level', level), field('Details', note), message);
  const submit = node('button', 'primary-button', 'Publish listing');
  submit.type = 'submit';
  form.append(submit);
  formPanel.append(form);

  const listingsPanel = panel('Open listings', 'Newest offers and requests from across the community.');
  listingsPanel.id = 'resourceListingPanel';
  append(grid, formPanel, listingsPanel);
  tabView.append(grid);
  wireJsonForm(form, '/api/resources', values => ({
    type: values.get('type'),
    category: values.get('category'),
    quantity: Number(values.get('quantity')),
    level: Number(values.get('level')),
    note: values.get('note')
  }), renderResources, message);

  try {
    const data = await api('/api/resources');
    if (!data.entries.length) listingsPanel.append(node('p', 'empty-state', 'No listings yet. Use the form to start the exchange.'));
    data.entries.forEach(entry => listingsPanel.append(makeResourceEntry(entry)));
  } catch (error) {
    listingsPanel.append(node('p', 'empty-state is-error', error.message));
  }
}

function makeHelpRequest(item) {
  const article = node('article', 'data-row');
  const copy = node('div', 'row-copy');
  append(copy, node('div', 'row-heading', `${item.kind} · Level ${item.level}`), node('p', '', item.details || 'Help requested; please contact the local relay.'), node('small', '', `${item.authorName} · ${timeAgo(item.createdAt)}`));
  article.append(copy);
  if (item.authorId === currentCitizen.id) {
    const close = node('button', 'text-button', 'Resolve');
    close.type = 'button';
    close.addEventListener('click', async () => {
      close.disabled = true;
      try {
        await api(`/api/network/help/${item.id}/close`, { method: 'POST' });
        await renderNetwork();
      } catch (error) {
        showToast(error.message);
        close.disabled = false;
      }
    });
    article.append(close);
  }
  return article;
}

async function renderNetwork() {
  tabView.replaceChildren(pageHeader('COMMUNITY MESH', 'Network & mutual aid', 'Share verified local updates and route help requests through the community.'));
  const grid = node('div', 'tab-grid network-grid');
  const postPanel = panel('Community updates', 'Short notices for relays, supplies, and local conditions.');
  const postForm = node('form', 'tab-form');
  const postBody = textInput('body', { multiline: true, maxLength: 400, placeholder: 'What should neighbors know?', required: true });
  const postMessage = submitMessage();
  append(postForm, field('Update', postBody), postMessage);
  const postSubmit = node('button', 'primary-button', 'Post update');
  postSubmit.type = 'submit';
  postForm.append(postSubmit);
  postPanel.append(postForm);
  const postList = node('div', 'data-list');
  postPanel.append(postList);

  const helpPanel = panel('Help relay', 'Requests are visible to the community and include your level.');
  const helpForm = node('form', 'tab-form');
  const kind = selectInput('kind', [['Medical', 'Medical'], ['Safety', 'Safety'], ['Supplies', 'Supplies']]);
  const details = textInput('details', { multiline: true, placeholder: 'Optional details for the nearest relay', required: false });
  const helpMessage = submitMessage();
  append(helpForm, field('Type of help', kind), field('Details', details), helpMessage);
  const helpSubmit = node('button', 'primary-button', 'Send help request');
  helpSubmit.type = 'submit';
  helpForm.append(helpSubmit);
  helpPanel.append(helpForm);
  const helpList = node('div', 'data-list');
  helpPanel.append(helpList);
  append(grid, postPanel, helpPanel);
  const mapPanel = panel('Schematic level map', 'Illustrative level plan. Activity is grouped by floor, not pinned to a home or exact location.');
  mapPanel.classList.add('map-panel');
  const mapControls = node('div', 'map-controls');
  const levelSelect = selectInput('mapLevel', Array.from({ length: 99 }, (_, index) => {
    const level = index + 1;
    return [String(level), `Level ${String(level).padStart(2, '0')}`];
  }), String(currentCitizen.level));
  mapControls.append(field('Show level', levelSelect));
  const layers = node('fieldset', 'map-layers');
  layers.append(node('legend', '', 'Map layers'));
  [['resources', 'Resource exchange'], ['help', 'Help requests'], ['health', 'Health reports']].forEach(([key, label]) => {
    const choice = node('label', 'check-option');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.name = key;
    append(choice, checkbox, node('span', '', label));
    layers.append(choice);
  });
  mapControls.append(layers);
  const mapSummary = node('p', 'map-summary', 'Loading level activity…');
  const svg = svgElement('svg', {
    class: 'level-map',
    viewBox: '0 0 800 360',
    role: 'group',
    'aria-label': 'Schematic floor plan with relay stations and community activity'
  });
  const mapDetails = node('div', 'map-details', 'Select a map marker for local activity details.');
  append(mapPanel, mapControls, mapSummary, svg, mapDetails);
  tabView.append(mapPanel, grid);

  wireJsonForm(postForm, '/api/network/posts', values => ({ body: values.get('body') }), renderNetwork, postMessage);
  wireJsonForm(helpForm, '/api/network/help', values => ({ kind: values.get('kind'), details: values.get('details') }), renderNetwork, helpMessage);
  const renderSelectedFloor = mapData => {
    const selectedLevel = Number(levelSelect.value);
    const citizens = mapData.citizensByLevel.find(item => item.level === selectedLevel)?.citizens || 0;
    const resources = mapData.resourceEntries.filter(item => item.level === selectedLevel).length;
    const requestCount = mapData.helpRequests.filter(item => item.level === selectedLevel).length;
    const reports = mapData.healthByLevel.find(item => item.level === selectedLevel)?.reports || 0;
    mapSummary.textContent = `Level ${String(selectedLevel).padStart(2, '0')} · ${citizens} citizens · ${resources} open listings · ${requestCount} open help ${requestCount === 1 ? 'request' : 'requests'} · ${reports} health reports (30 days)`;
    const filters = Object.fromEntries([...layers.querySelectorAll('input')].map(input => [input.name, input.checked]));
    drawLevelMap(svg, mapData, selectedLevel, filters, mapDetails);
  };
  levelSelect.addEventListener('change', () => { if (mapData) renderSelectedFloor(mapData); });
  layers.addEventListener('change', () => { if (mapData) renderSelectedFloor(mapData); });
  let mapData;
  try {
    mapData = await api('/api/network/map');
    renderSelectedFloor(mapData);
  } catch (error) {
    mapSummary.textContent = error.message;
    mapSummary.classList.add('is-error');
  }
  try {
    const [postData, helpData] = await Promise.all([api('/api/network/posts'), api('/api/network/help')]);
    if (!postData.posts.length) postList.append(node('p', 'empty-state', 'No updates yet.'));
    postData.posts.forEach(post => postList.append(makeUpdate(post)));
    if (!helpData.requests.length) helpList.append(node('p', 'empty-state', 'No help requests yet.'));
    helpData.requests.forEach(item => helpList.append(makeHelpRequest(item)));
  } catch (error) {
    postList.append(node('p', 'empty-state is-error', error.message));
  }
}

function makeMetric(label, value, note) {
  const metric = node('article', 'summary-card');
  append(metric, node('span', '', label), node('strong', '', String(value)), node('small', '', note));
  return metric;
}

async function renderHealth() {
  tabView.replaceChildren(pageHeader('COMMUNITY HEALTH', 'Respiratory health watch', 'Self-reported trends help stewards direct supplies. Reports are anonymous and are not a medical diagnosis.'));
  const summary = node('div', 'summary-grid');
  const formPanel = panel('Submit an anonymous report', 'Do not include your name or other identifying details.');
  const form = node('form', 'tab-form');
  const symptomGroup = node('fieldset', 'symptom-fieldset');
  symptomGroup.append(node('legend', '', 'Symptoms (select all that apply)'));
  [['Cough', 'Cough'], ['Fever', 'Fever'], ['Shortness of breath', 'Shortness of breath'], ['Chest discomfort', 'Chest discomfort'], ['Fatigue', 'Fatigue']].forEach(([value, label]) => {
    const choice = node('label', 'check-option');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'symptoms';
    checkbox.value = value;
    append(choice, checkbox, node('span', '', label));
    symptomGroup.append(choice);
  });
  const severity = selectInput('severity', [['Mild', 'Mild'], ['Moderate', 'Moderate'], ['Severe', 'Severe']]);
  const supply = selectInput('supplyNeed', [['None', 'No supplies needed'], ['Masks', 'Masks'], ['Air filters', 'Air filters'], ['Medicine', 'Medicine'], ['Oxygen', 'Oxygen']]);
  const level = textInput('level', { type: 'number', min: 1, max: 99, value: currentCitizen.level });
  const message = submitMessage();
  append(form, symptomGroup, field('How severe are the symptoms?', severity), field('Supply need', supply), field('Level', level), message);
  const submit = node('button', 'primary-button', 'Submit report');
  submit.type = 'submit';
  form.append(submit);
  formPanel.append(form);

  const trendPanel = panel('Reports by day', 'Anonymous reports submitted over the last seven days.');
  const trend = node('div', 'trend-chart');
  trendPanel.append(trend);
  const levelPanel = panel('Reports by level', 'Thirty-day totals help prioritize local distribution.');
  const levelList = node('div', 'data-list');
  levelPanel.append(levelList);
  const needsPanel = panel('Supply needs', 'Requested supplies in anonymous reports over the last 30 days.');
  const needsList = node('div', 'data-list');
  needsPanel.append(needsList);
  const symptomsPanel = panel('Reported symptoms', 'Symptoms selected in self-reported health submissions.');
  const symptomsList = node('div', 'data-list');
  symptomsPanel.append(symptomsList);
  const lower = node('div', 'tab-grid');
  append(lower, levelPanel, needsPanel, symptomsPanel);
  const healthGrid = node('div', 'tab-grid health-grid');
  append(healthGrid, formPanel, trendPanel);
  tabView.append(summary, healthGrid);
  tabView.append(lower);
  wireJsonForm(form, '/api/health/reports', values => ({
    symptoms: values.getAll('symptoms'),
    severity: values.get('severity'),
    supplyNeed: values.get('supplyNeed'),
    level: Number(values.get('level'))
  }), renderHealth, message);

  try {
    const data = await api('/api/health/summary');
    summary.append(
      makeMetric('30-day reports', data.month, 'Self-reported'),
      makeMetric('Last 7 days', data.lastSevenDays, `${data.lastSevenDays > data.previousSevenDays ? 'Above' : 'At or below'} prior 7 days`),
      makeMetric('Severe · 7 days', data.severe, 'Prioritize local support')
    );
    const daily = new Map(data.daily.map(row => [row._id, row]));
    const max = Math.max(1, ...data.daily.map(row => row.reports));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - offset);
      const key = date.toISOString().slice(0, 10);
      const row = daily.get(key);
      const count = row ? row.reports : 0;
      const bar = node('div', 'trend-item');
      const column = node('div', 'trend-bar-wrap');
      const barFill = node('span', 'trend-bar');
      barFill.style.height = `${Math.max(3, Math.round(92 * count / max))}%`;
      barFill.setAttribute('aria-label', `${count} reports`);
      append(column, node('b', '', String(count)), barFill);
      append(bar, column, node('small', '', date.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })));
      trend.append(bar);
    }
    if (!data.byLevel.length) levelList.append(node('p', 'empty-state', 'No reports in the last 30 days.'));
    data.byLevel.forEach(item => levelList.append(makeDataRow(`Level ${item.level}`, `${item.reports} reports · ${item.severe} severe`)));
    if (!data.supplyNeeds.length) needsList.append(node('p', 'empty-state', 'No supply requests recorded.'));
    data.supplyNeeds.forEach(item => needsList.append(makeDataRow(item.supply, `${item.reports} reports`)));
    if (!data.symptomCounts.length) symptomsList.append(node('p', 'empty-state', 'No symptoms reported.'));
    data.symptomCounts.forEach(item => symptomsList.append(makeDataRow(item.symptom, `${item.reports} reports`)));
  } catch (error) {
    summary.append(node('p', 'empty-state is-error', error.message));
  }
}

function makeDataRow(title, description) {
  const row = node('article', 'data-row');
  append(row, node('strong', '', title), node('span', 'row-secondary', description));
  return row;
}

async function renderCitizens() {
  tabView.replaceChildren(pageHeader('CITIZEN DIRECTORY', 'Community members', 'Find neighbors by name or level. Contact details are never shown in the directory.'));
  const panelElement = panel('Registered citizens', 'Demo residents appear first and are labeled. Load more to browse additional citizens.');
  const controls = node('div', 'directory-controls');
  const search = textInput('citizenSearch', { required: false, placeholder: 'Search name or level' });
  search.setAttribute('aria-label', 'Search citizens by name or level');
  search.setAttribute('autocomplete', 'off');
  search.setAttribute('maxlength', '80');
  controls.append(search);
  const count = node('p', 'directory-count', 'Loading directory…');
  const list = node('div', 'data-list');
  const loadMore = node('button', 'text-button directory-more', 'Load more citizens');
  loadMore.type = 'button';
  loadMore.hidden = true;
  append(panelElement, controls, count, list, loadMore);
  tabView.append(panelElement);
  let page = 1;
  let loading = false;
  let hasMore = false;
  let query = '';
  let allLoaded = 0;
  let allMatches = 0;

  async function loadCitizens(reset = false) {
    if (loading) return;
    loading = true;
    loadMore.disabled = true;
    if (reset) {
      page = 1;
      allLoaded = 0;
      list.replaceChildren();
    }
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set('search', query);
      const data = await api(`/api/citizens?${params}`);
      document.getElementById('sidebarCitizenCount').textContent =
        query ? `${data.total.toLocaleString()} matching` : data.total.toLocaleString();
      allMatches = data.total;
      hasMore = data.hasMore;
      allLoaded += data.citizens.length;
      if (!data.citizens.length && reset) {
        list.append(node('p', 'empty-state', 'No citizens match that search.'));
      }
      data.citizens.forEach(citizen => {
        const row = node('article', 'citizen-row');
        append(row, node('span', 'update-avatar green', initials(citizen.name)), node('strong', '', citizen.name));
        if (citizen.isDemo) row.append(node('span', 'demo-badge', 'DEMO'));
        row.append(node('span', 'row-secondary', `Level ${citizen.level}`));
        list.append(row);
      });
      count.textContent = query
        ? `Showing ${allLoaded} of ${allMatches.toLocaleString()} matching citizens`
        : `Showing ${allLoaded} of ${allMatches.toLocaleString()} citizens`;
      page += 1;
    } catch (error) {
      if (reset) list.replaceChildren();
      list.append(node('p', 'empty-state is-error', error.message));
      count.textContent = '';
      hasMore = false;
    } finally {
      loading = false;
      loadMore.hidden = !hasMore;
      loadMore.disabled = false;
      loadMore.textContent = hasMore ? 'Load more citizens' : 'All matching citizens loaded';
    }
  }

  loadMore.addEventListener('click', () => loadCitizens());
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    query = search.value.trim();
    searchTimer = setTimeout(() => loadCitizens(true), 200);
  });
  try {
    await loadCitizens(true);
  } catch (error) {
    list.append(node('p', 'empty-state is-error', error.message));
    count.textContent = '';
  }
}

const dialog = document.getElementById('sosDialog');
document.getElementById('sosButton').addEventListener('click', () => dialog.showModal());
document.getElementById('closeDialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});
document.querySelectorAll('.sos-options button').forEach(button => {
  button.addEventListener('click', async () => {
    dialog.close();
    try {
      await api('/api/network/help', {
        method: 'POST',
        body: JSON.stringify({ kind: button.dataset.help, details: '' })
      });
      showToast(`${button.dataset.help} request sent to the community relay`);
      if (currentView === 'network') renderNetwork();
    } catch (error) {
      showToast(error.message);
    }
  });
});

document.getElementById('meshButton').addEventListener('click', () => switchView('network'));
document.getElementById('detailsButton').addEventListener('click', () => switchView('resources'));
document.getElementById('healthButton').addEventListener('click', () => switchView('health'));
document.getElementById('addPostButton').addEventListener('click', () => switchView('network'));
