const mongoose = require('mongoose');
const PostSchema = new mongoose.Schema({
  id:         Number,
  title:      String,
  content:    String,
  authorId:   Number,
  authorName: String,
  createdAt:  String,
  updatedAt:  String,
  likes:      [Number],
  comments:   [{
    id:         Number,
    content:    String,
    authorId:   Number,
    authorName: String,
    createdAt:  String
  }],
  pinned: { type: Boolean, default: false }
});
module.exports = mongoose.model('Post', PostSchema);