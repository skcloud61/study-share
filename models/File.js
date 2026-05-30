const mongoose = require('mongoose');
const FileSchema = new mongoose.Schema({
  id:           Number,
  subject:      String,
  type:         String,
  title:        String,
  desc:         String,
  originalName: String,
  savedName:    String,
  ext:          String,
  uploadedBy:   String,
  uploadedById: Number,
  createdAt:    String
});
module.exports = mongoose.model('File', FileSchema);