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
  Notes about reply/quote handling:
  - The client sends `data.replyTo` when replying (shape: { username, message }).
  - We must preserve that object on the server and include it in emitted messages.
  - For public messages we include replyTo in the saved/broadcast message.
  - For private messages we include replyTo and emit to both receiver and sender.
*/

io.on('connection', (socket) => {
  // Store username on socket when a client joins
  socket.on('join', (username) => {
    if (!username || typeof username !== 'string') {
      socket.emit('join error', 'Invalid username');
      return;
    }

    username = username.trim();

    // Basic duplicate username check
    if (users[username] && users[username] !== socket.id) {
      socket.emit('join error', 'Username is already taken');
      return;
    }

    // IMPORTANT: Save username to socket so we can attribute messages
    socket.username = username;
    users[username] = socket.id;

    // Send public chat history and broadcast updated user list
    socket.emit('chat history', publicMessages);
    io.emit('user list', Object.keys(users));

    console.log(`${username} joined (id=${socket.id})`);
  });

  // Handle incoming chat messages (public or private)
  socket.on('chat message', (data) => {
    // Require that the sender has joined
    if (!socket.username) {
      socket.emit('chat error', 'You must join before sending messages');
      return;
    }

    if (!data || typeof data.text !== 'string' || !data.text.trim()) {
      socket.emit('chat error', 'Message text is required');
      return;
    }

    // Preserve replyTo exactly as sent by the frontend (may be null)
    // Expected shape: { username, message }
    const replyTo = data.replyTo || null;

    // Build message object and include replyTo (this is the key fix)
    const message = {
      user: socket.username,
      text: data.text.trim(),
      time: data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      replyTo: replyTo // preserved for client-side rendering of quotes
    };

    // If a targetUser is present, send as private message
    const targetUser = data.targetUser && String(data.targetUser).trim();
    if (targetUser) {
      const targetSocketId = users[targetUser];

      if (!targetSocketId) {
        socket.emit('chat error', 'Target user is not online');
        return;
      }

      // Emit private message to recipient with replyTo preserved
      io.to(targetSocketId).emit('private message', {
        ...message,
        from: socket.username,
        to: targetUser
      });

      // Also emit back to sender so their UI receives the same message (with replyTo)
      socket.emit('private message', {
        ...message,
        from: socket.username,
        to: targetUser
      });

      return;
    }

    // PUBLIC message: save to history and broadcast including replyTo
    publicMessages.push(message);

    // Keep history bounded
    if (publicMessages.length > 1000) {
      publicMessages.shift();
    }

    // Broadcast public chat message (replyTo included)
    io.emit('chat message', message);
  });

  // Clean up on disconnect
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
