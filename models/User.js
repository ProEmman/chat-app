const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatar: { type: String, default: null } // URL or base64, optional
});

module.exports = mongoose.model('User', userSchema);
