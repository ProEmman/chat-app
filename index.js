require("dotenv").config();
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const Message = require("./models/Message");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

/* =========================
   🔐 REGISTER ROUTE
   Accept optional avatar and save it
========================= */
app.post("/register", async (req, res) => {
  try {
    const { username, password, avatar } = req.body;

    if (!username || !password) {
      return res.json({ message: "Username and password are required" });
    }

    const existingUser = await User.findOne({ username });

    if (existingUser) {
      return res.json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      username,
      password: hashedPassword,
      avatar: avatar || null
    });

    await newUser.save();

    res.json({ message: "User registered successfully" });

  } catch (error) {
    console.log(error);
    res.json({ message: "Server error" });
  }
});

/* =========================
   🔐 LOGIN ROUTE
   Return avatar along with token
========================= */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.json({ message: "Username and password are required" });
    }

    const user = await User.findOne({ username });

    if (!user) {
      return res.json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { username: user.username },
      "secretkey",
      { expiresIn: "1h" }
    );

    res.json({
      message: "Login successful",
      token,
      avatar: user.avatar || null
    });

  } catch (error) {
    console.log(error);
    res.json({ message: "Server error" });
  }
});

/* =========================
   💬 CHAT SYSTEM (MongoDB-backed)
   - Clients must provide JWT in socket.handshake.auth.token
   - We verify token, extract decoded.username and assign to socket.username
   - Load user record to get avatar and assign to socket.avatar
   - If token missing/invalid => disconnect socket
   - After successful auth emit chat history (from MongoDB) and user list
   - All message handlers are registered after auth succeeds
========================= */

const users = {}; // username -> socket.id
const lastSeen = {}; // username -> ISO timestamp when they went offline

io.on('connection', (socket) => {
  // Expect token in socket.handshake.auth.token
  const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;

  if (!token) {
    console.log('Socket connected without token, disconnecting:', socket.id);
    socket.emit('auth error', 'Missing token');
    socket.disconnect();
    return;
  }

  // Verify token and set up handlers only on success
  jwt.verify(token, "secretkey", async (err, decoded) => {
    if (err || !decoded || !decoded.username) {
      console.log('Invalid token for socket, disconnecting:', socket.id, err && err.message);
      socket.emit('auth error', 'Invalid token');
      socket.disconnect();
      return;
    }

    // Authentication succeeded
    const username = decoded.username;
    socket.username = username;

    // Load user to get avatar and other info
    try {
      const userDoc = await User.findOne({ username }).lean().exec();
      socket.avatar = (userDoc && userDoc.avatar) ? userDoc.avatar : null;
    } catch (e) {
      socket.avatar = null;
    }

    // Register/replace user mapping
    users[username] = socket.id;
    // user is online now, clear any lastSeen
    if (lastSeen[username]) delete lastSeen[username];

    // Fetch last 50 messages from MongoDB and send to client (oldest first)
    try {
      let messages = await Message.find().sort({ _id: -1 }).limit(50).lean().exec();
      messages = messages.reverse();
      socket.emit('chat history', messages);
    } catch (dbErr) {
      console.error('Failed to load chat history:', dbErr);
      socket.emit('chat history', []);
    }

    // Broadcast updated user list (array of usernames) and lastSeen map
    io.emit('user list', Object.keys(users));
    io.emit('user last seen', lastSeen);

    console.log(`${username} authenticated and connected (id=${socket.id})`);

    // ---- Message handlers (registered after auth) ----
    socket.on('chat message', async (data) => {
      if (!socket.username) {
        socket.emit('chat error', 'You must be authenticated to send messages');
        return;
      }

      if (!data || (typeof data.text !== 'string' && !data.image)) {
        socket.emit('chat error', 'Message text or image is required');
        return;
      }

      const replyTo = data.replyTo || null;
      const image = data.image || null;
      const text = (typeof data.text === 'string' ? data.text.trim() : '') || '';
      const time = data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const messagePayload = {
        user: socket.username,
        text,
        image,
        time,
        replyTo,
        avatar: socket.avatar || null
      };

      const targetUser = data.targetUser && String(data.targetUser).trim();

      if (targetUser) {
        const targetSocketId = users[targetUser];

        if (!targetSocketId) {
          socket.emit('chat error', 'Target user is not online');
          return;
        }

        io.to(targetSocketId).emit('private message', {
          ...messagePayload,
          from: socket.username,
          to: targetUser
        });

        socket.emit('private message', {
          ...messagePayload,
          from: socket.username,
          to: targetUser
        });

        return;
      }

      // PUBLIC message: save to MongoDB and broadcast
      try {
        const newMessage = new Message(messagePayload);
        const saved = await newMessage.save();
        // Convert to plain object for emission
        const savedObj = saved.toObject();
        // Broadcast public chat message (replyTo, image, avatar included)
        io.emit('chat message', {
          user: savedObj.user,
          text: savedObj.text,
          image: savedObj.image,
          time: savedObj.time,
          replyTo: savedObj.replyTo,
          avatar: savedObj.avatar || null
        });
      } catch (saveErr) {
        console.error('Failed to save message:', saveErr);
        socket.emit('chat error', 'Failed to save message');
      }
    });

    // Clean up on disconnect
    socket.on('disconnect', () => {
      if (socket.username) {
        // Only remove mapping if it still points to this socket id
        if (users[socket.username] === socket.id) {
          delete users[socket.username];
        }
        // record last seen timestamp
        const when = new Date().toISOString();
        lastSeen[socket.username] = when;

        // Broadcast updated user list and the lastSeen info
        io.emit('user list', Object.keys(users));
        io.emit('user last seen', { [socket.username]: when });

        console.log(`${socket.username} disconnected (id=${socket.id})`);
      } else {
        console.log('Unauthenticated socket disconnected:', socket.id);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});