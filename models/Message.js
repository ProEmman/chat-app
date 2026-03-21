const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  user: { type: String, required: true }, // sender username
  text: { type: String, default: '' },
  image: { type: String, default: null }, // base64 data URL or image URL
  time: { type: String, default: '' },
  replyTo: { type: Object, default: null } // shape preserved from frontend (e.g. { username, message })
});

module.exports = mongoose.model('Message', messageSchema);