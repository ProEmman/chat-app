const express = require('express');
const fs = require('fs');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

const messagesFile = __dirname + '/messages.json';
let messages = [];
let users = [];

// Load messages when server starts
try {
  if (fs.existsSync(messagesFile)) {
    const fileData = fs.readFileSync(messagesFile, 'utf8');

    if (fileData.trim()) {
      const parsedMessages = JSON.parse(fileData);

      if (Array.isArray(parsedMessages)) {
        messages = parsedMessages;
      }
    }
  }
} catch (error) {
  console.log('Could not read messages.json. Starting with empty chat history.');
  messages = [];
}

io.on('connection', (socket) => {
  console.log('a user connected');

  socket.emit('chat history', messages);
  socket.emit('user list', users);

  socket.on('join', (username) => {
    if (!username || typeof username !== 'string') return;

    const cleanUsername = username.trim();
    if (!cleanUsername) return;

    socket.username = cleanUsername;
    users.push(cleanUsername);

    io.emit('user list', users);
  });

  // Typing indicator events
  socket.on('typing', (username) => {
    if (!username || typeof username !== 'string') return;
    socket.broadcast.emit('typing', username);
  });

  socket.on('stop typing', (username) => {
    if (!username || typeof username !== 'string') return;
    socket.broadcast.emit('stop typing', username);
  });

  socket.on('chat message', (msg) => {
    messages.push(msg);

    try {
      fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));
    } catch (error) {
      console.log('Could not save messages to messages.json');
    }

    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      const index = users.indexOf(socket.username);
      if (index !== -1) {
        users.splice(index, 1);
      }

      io.emit('user list', users);
      socket.broadcast.emit('stop typing', socket.username);
    }

    console.log('user disconnected');
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log('Server is running on port ' + PORT);
});