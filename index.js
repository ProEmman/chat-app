const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const messagesFile = path.join(__dirname, 'messages.json');

app.use(express.static(__dirname));

let publicMessages = [];
const users = new Map();

function loadMessages() {
  try {
    if (!fs.existsSync(messagesFile)) {
      publicMessages = [];
      return;
    }

    const fileData = fs.readFileSync(messagesFile, 'utf8');
    if (!fileData.trim()) {
      publicMessages = [];
      return;
    }

    const parsedData = JSON.parse(fileData);
    publicMessages = Array.isArray(parsedData) ? parsedData : [];
  } catch (error) {
    console.log('Could not read messages.json. Starting with empty public chat history.');
    publicMessages = [];
  }
}

function saveMessages() {
  try {
    fs.writeFileSync(messagesFile, JSON.stringify(publicMessages, null, 2));
  } catch (error) {
    console.log('Could not save public messages to messages.json');
  }
}

function getOnlineUsers() {
  return Array.from(users.values())
    .map((user) => user.username)
    .sort((a, b) => a.localeCompare(b));
}

function getUserByUsername(username) {
  const cleanUsername = String(username || '').trim();

  for (const user of users.values()) {
    if (user.username === cleanUsername) {
      return user;
    }
  }

  return null;
}

loadMessages();

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.emit('chat history', publicMessages);
  socket.emit('user list', getOnlineUsers());

  socket.on('join', (username) => {
    const cleanUsername = String(username || '').trim();
    if (!cleanUsername) return;

    const existingUser = getUserByUsername(cleanUsername);
    if (existingUser && existingUser.socketId !== socket.id) {
      socket.emit('join error', 'That username is already in use. Please choose another one.');
      return;
    }

    socket.username = cleanUsername;
    users.set(socket.id, {
      username: cleanUsername,
      socketId: socket.id
    });

    io.emit('user list', getOnlineUsers());
  });

  socket.on('chat message', (payload) => {
    if (!socket.username) return;

    const text = String(payload && payload.text ? payload.text : '').trim();
    const targetUser = String(payload && payload.targetUser ? payload.targetUser : '').trim();

    if (!text) return;

    const messageData = {
      user: socket.username,
      text,
      time: payload && payload.time ? payload.time : new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
    };

    if (!targetUser) {
      publicMessages.push(messageData);
      saveMessages();
      io.emit('chat message', messageData);
      return;
    }

    const target = getUserByUsername(targetUser);

    if (!target) {
      socket.emit('chat error', 'Selected user is no longer online.');
      return;
    }

    io.to(target.socketId).emit('private message', {
      ...messageData,
      from: socket.username,
      to: target.username
    });

    socket.emit('private message', {
      ...messageData,
      from: socket.username,
      to: target.username
    });
  });

  socket.on('disconnect', () => {
    if (users.has(socket.id)) {
      users.delete(socket.id);
      io.emit('user list', getOnlineUsers());
    }

    console.log('User disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
