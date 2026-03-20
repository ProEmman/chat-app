const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend files (index.html etc.)
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

/*
  In-memory stores:
  - publicMessages: history for public chat
  - users: map username -> socket.id for routing private messages
*/
const publicMessages = [];
const users = {}; // { username: socketId }

/*
  Notes:
  - Accept `data.image` from clients (base64 data URL).
  - Preserve `replyTo` and `image` inside the server message object.
  - For public messages: save & broadcast message (includes image + replyTo).
  - For private messages: emit 'private message' to both recipient and sender (includes image + replyTo).
*/

io.on('connection', (socket) => {
  // When a user joins, store their username on the socket and in users map
  socket.on('join', (username) => {
    if (!username || typeof username !== 'string') {
      socket.emit('join error', 'Invalid username');
      return;
    }

    username = username.trim();

    // Prevent duplicate usernames (basic check)
    if (users[username] && users[username] !== socket.id) {
      socket.emit('join error', 'Username is already taken');
      return;
    }

    // Save username on the socket (required)
    socket.username = username;
    users[username] = socket.id;

    // Send chat history (public)
    socket.emit('chat history', publicMessages);

    // Broadcast updated user list to everyone
    io.emit('user list', Object.keys(users));

    console.log(`${username} joined (id=${socket.id})`);
  });

  // Handle incoming chat messages (public or private)
  socket.on('chat message', (data) => {
    // Validate sender
    if (!socket.username) {
      socket.emit('chat error', 'You must join before sending messages');
      return;
    }

    if (!data || (typeof data.text !== 'string' && !data.image)) {
      socket.emit('chat error', 'Message text or image is required');
      return;
    }

    // Preserve replyTo exactly as sent by the frontend (may be null)
    const replyTo = data.replyTo || null;

    // Preserve image (base64 data URL) if provided
    const image = data.image || null;

    // Build message object and include replyTo + image (key fix)
    const message = {
      user: socket.username,
      text: (typeof data.text === 'string' ? data.text.trim() : '') || '',
      image: image, // base64 or null
      time: data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      replyTo: replyTo // preserved for client-side rendering of quotes
    };

    // If targetUser is provided, treat as private message
    const targetUser = data.targetUser && String(data.targetUser).trim();
    if (targetUser) {
      const targetSocketId = users[targetUser];

      if (!targetSocketId) {
        socket.emit('chat error', 'Target user is not online');
        return;
      }

      // Send private message to the recipient (include image + replyTo)
      io.to(targetSocketId).emit('private message', {
        ...message,
        from: socket.username,
        to: targetUser
      });

      // Also send the private message back to the sender so their UI receives the same message
      socket.emit('private message', {
        ...message,
        from: socket.username,
        to: targetUser
      });

      return;
    }

    // PUBLIC message: save to history and broadcast including replyTo & image
    publicMessages.push(message);

    // Optionally cap history to keep memory bounded
    if (publicMessages.length > 1000) {
      publicMessages.shift();
    }

    // Broadcast public chat message (replyTo and image included)
    io.emit('chat message', message);
  });

  // When client disconnects, remove from users list and broadcast user list update
  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.username];
      io.emit('user list', Object.keys(users));
      console.log(`${socket.username} disconnected (id=${socket.id})`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
