const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/chat-app';
const PUBLIC_ROOM = 'public';

app.use(express.static(__dirname));

const messageSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  room: {
    type: String,
    required: true,
    index: true
  }
});

const Message = mongoose.model('Message', messageSchema);

const onlineUsers = new Map();

function normalizeUsername(value) {
  return String(value || '').trim();
}

function getUserRoom(username) {
  return `user:${username}`;
}

function getPrivateRoom(userA, userB) {
  return [userA, userB].sort().join('__');
}

function buildRoomDetails(currentUser, targetUser) {
  if (!targetUser || targetUser === PUBLIC_ROOM) {
    return {
      room: PUBLIC_ROOM,
      type: 'public',
      targetUser: null
    };
  }

  return {
    room: getPrivateRoom(currentUser, targetUser),
    type: 'private',
    targetUser
  };
}

function formatMessageDocument(doc, currentUser) {
  const isPrivate = doc.room !== PUBLIC_ROOM;
  let targetUser = null;

  if (isPrivate) {
    const names = doc.room.split('__');
    targetUser = names.find((name) => name !== currentUser) || null;
  }

  return {
    id: String(doc._id),
    user: doc.username,
    text: doc.message,
    timestamp: doc.timestamp,
    room: doc.room,
    type: isPrivate ? 'private' : 'public',
    targetUser
  };
}

function getOnlineUsersList() {
  return Array.from(onlineUsers.keys()).sort((a, b) => a.localeCompare(b));
}

async function sendRoomHistory(socket, targetUser) {
  if (!socket.username) return;

  const roomDetails = buildRoomDetails(socket.username, normalizeUsername(targetUser));
  const history = await Message.find({ room: roomDetails.room })
    .sort({ timestamp: 1 })
    .limit(100)
    .lean();

  socket.emit('chat history', {
    room: roomDetails.room,
    type: roomDetails.type,
    targetUser: roomDetails.targetUser,
    messages: history.map((item) => formatMessageDocument(item, socket.username))
  });
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error.message);
  });

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('join', async (username) => {
    const cleanUsername = normalizeUsername(username);
    if (!cleanUsername) return;

    if (onlineUsers.has(cleanUsername)) {
      socket.emit('join error', 'That username is already in use. Please choose another one.');
      return;
    }

    socket.username = cleanUsername;
    socket.join(getUserRoom(cleanUsername));
    onlineUsers.set(cleanUsername, socket.id);

    io.emit('user list', getOnlineUsersList());

    try {
      await sendRoomHistory(socket, PUBLIC_ROOM);
    } catch (error) {
      console.error('Could not load public chat history:', error.message);
      socket.emit('chat history', {
        room: PUBLIC_ROOM,
        type: 'public',
        targetUser: null,
        messages: []
      });
    }
  });

  socket.on('load history', async (targetUser) => {
    if (!socket.username) return;

    try {
      await sendRoomHistory(socket, targetUser);
    } catch (error) {
      console.error('Could not load room history:', error.message);
    }
  });

  socket.on('typing', ({ targetUser }) => {
    if (!socket.username) return;

    const cleanTarget = normalizeUsername(targetUser);

    if (!cleanTarget || cleanTarget === PUBLIC_ROOM) {
      socket.broadcast.emit('typing', {
        user: socket.username,
        type: 'public',
        targetUser: null
      });
      return;
    }

    io.to(getUserRoom(cleanTarget)).emit('typing', {
      user: socket.username,
      type: 'private',
      targetUser: cleanTarget
    });
  });

  socket.on('stop typing', ({ targetUser }) => {
    if (!socket.username) return;

    const cleanTarget = normalizeUsername(targetUser);

    if (!cleanTarget || cleanTarget === PUBLIC_ROOM) {
      socket.broadcast.emit('stop typing', {
        user: socket.username,
        type: 'public',
        targetUser: null
      });
      return;
    }

    io.to(getUserRoom(cleanTarget)).emit('stop typing', {
      user: socket.username,
      type: 'private',
      targetUser: cleanTarget
    });
  });

  socket.on('chat message', async ({ text, targetUser }) => {
    if (!socket.username) return;

    const cleanText = String(text || '').trim();
    if (!cleanText) return;

    const roomDetails = buildRoomDetails(socket.username, normalizeUsername(targetUser));

    try {
      const newMessage = await Message.create({
        username: socket.username,
        message: cleanText,
        room: roomDetails.room
      });

      const payload = formatMessageDocument(newMessage.toObject(), socket.username);

      if (roomDetails.type === 'public') {
        io.emit('chat message', payload);
      } else if (roomDetails.targetUser) {
        payload.targetUser = roomDetails.targetUser;
        io.to(getUserRoom(socket.username)).emit('chat message', payload);
        io.to(getUserRoom(roomDetails.targetUser)).emit('chat message', {
          ...payload,
          targetUser: socket.username
        });
      }
    } catch (error) {
      console.error('Could not save message:', error.message);
      socket.emit('chat error', 'Message could not be saved.');
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      io.emit('user list', getOnlineUsersList());
      socket.broadcast.emit('stop typing', {
        user: socket.username,
        type: 'public',
        targetUser: null
      });
    }

    console.log('User disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
