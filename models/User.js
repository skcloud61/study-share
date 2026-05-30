const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({
  id:        Number,
  username:  String,
  password:  String,
  name:      String,
  role:      { type: String, default: 'user' },
  approved:  { type: Boolean, default: false },
  createdAt: String
});
module.exports = mongoose.model('User', UserSchema);