require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const FONTS_DIR = path.join(__dirname, 'fonts');
const FONT_PATH = path.join(FONTS_DIR, 'NotoSansKR.ttf');

if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });

// Cloudinary 설정
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});



// ================================
//  MONGOOSE 모델
// ================================
const UserSchema = new mongoose.Schema({
  id: Number,
  username: String,
  password: String,
  name: String,
  role: { type: String, default: 'user' },
  approved: { type: Boolean, default: false },
  createdAt: String
});
const User = mongoose.model('User', UserSchema);

const FileSchema = new mongoose.Schema({
  id: Number,
  subject: String,
  type: String,
  title: String,
  desc: String,
  originalName: String,
  savedName: String,
  cloudinaryId: String,
  cloudinaryUrl: String,
  ext: String,
  uploadedBy: String,
  uploadedById: Number,
  createdAt: String
});
const File = mongoose.model('File', FileSchema);

const PostSchema = new mongoose.Schema({
  id: Number,
  title: String,
  content: String,
  authorId: Number,
  authorName: String,
  createdAt: String,
  updatedAt: String,
  likes: [Number],
  comments: [{
    id: Number,
    content: String,
    authorId: Number,
    authorName: String,
    createdAt: String
  }],
  pinned: { type: Boolean, default: false }
});
const Post = mongoose.model('Post', PostSchema);

const UserInfoSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  username: String,
  ip: String,
  collectedAt: String
}, { strict: false });
const UserInfo = mongoose.model('UserInfo', UserInfoSchema);

// ================================
//  폰트 다운로드
// ================================
function downloadFont() {
  return new Promise((resolve) => {
    if (fs.existsSync(FONT_PATH)) return resolve();
    console.log('폰트 다운로드 중...');
    const url = 'https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf';
    const file = fs.createWriteStream(FONT_PATH);
    function getUrl(u) {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return getUrl(res.headers.location);
        res.pipe(file);
        file.on('finish', () => { file.close(); console.log('폰트 다운로드 완료'); resolve(); });
      }).on('error', (e) => { console.log('폰트 다운로드 실패:', e.message); resolve(); });
    }
    getUrl(url);
  });
}

// ================================
//  초기 admin 계정 생성
// ================================
async function initAdmin() {
  const exists = await User.findOne({ username: 'admin' });
  if (!exists) {
    const hash = bcrypt.hashSync('admin1234', 10);
    await User.create({
      id: 1, username: 'admin', password: hash,
      name: '관리자', role: 'admin', approved: true,
      createdAt: new Date().toISOString()
    });
    console.log('admin 계정 생성 완료');
  }
}

// ================================
//  Multer Cloudinary 설정
// ================================
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    file.originalname = original;
    return {
      folder: 'studyshare',
      resource_type: 'raw',
      public_id: Date.now() + '_' + Math.random().toString(36).slice(2),
      format: path.extname(original).slice(1)
    };
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.docx', '.pptx', '.hwp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ================================
//  미들웨어
// ================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use(session({
  secret: process.env.SESSION_SECRET || 'studyshare-secret-2025',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// ================================
//  인증 미들웨어
// ================================
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  next();
}

// ================================
//  AUTH
// ================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
  if (!user.approved)
    return res.json({ success: false, message: '관리자 승인 대기중입니다.' });
  req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/register', async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name)
    return res.json({ success: false, message: '모든 항목을 입력해주세요' });
  const exists = await User.findOne({ username });
  if (exists)
    return res.json({ success: false, message: '이미 존재하는 아이디입니다.' });
  await User.create({
    id: Date.now(), username, name,
    password: bcrypt.hashSync(password, 10),
    role: 'user', approved: false,
    createdAt: new Date().toISOString()
  });
  res.json({ success: true, message: '가입 완료. 관리자 승인 후 사용 가능합니다.' });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

// ================================
//  FILES
// ================================
app.get('/api/files', requireLogin, async (req, res) => {
  try {
    const files = await File.find().sort({ id: -1 });
    res.json(files.map(f => ({
      id: f.id, subject: f.subject, type: f.type,
      title: f.title, desc: f.desc,
      originalName: f.originalName, ext: f.ext,
      uploadedBy: f.uploadedBy, uploadedById: f.uploadedById,
      createdAt: f.createdAt
    })));
  } catch(e) {
    console.error('파일 목록 오류:', e.message);
    res.json([]);
  }
});

app.post('/api/upload', requireLogin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ success: false, message: '파일을 선택해주세요' });
  const { subject, type, title, desc } = req.body;
  if (!subject || !type || !title)
    return res.json({ success: false, message: '모든 항목을 입력해주세요' });
  const original = req.file.originalname;
  const item = await File.create({
    id: Date.now(),
    subject, type, title,
    desc: desc || '',
    originalName: original,
    savedName: req.file.filename,
    cloudinaryId: req.file.filename,
    cloudinaryUrl: req.file.path,
    ext: path.extname(original).toLowerCase(),
    uploadedBy: req.session.user.name,
    uploadedById: req.session.user.id,
    createdAt: new Date().toISOString().slice(0, 10)
  });
  res.json({ success: true, item });
});

app.delete('/api/files/:id', requireLogin, async (req, res) => {
  const file = await File.findOne({ id: Number(req.params.id) });
  if (!file) return res.json({ success: false });
  if (req.session.user.role !== 'admin' && file.uploadedById !== req.session.user.id)
    return res.status(403).json({ error: '권한 없음' });
  try {
    await cloudinary.uploader.destroy(file.cloudinaryId, { resource_type: 'raw' });
  } catch (e) {
    console.log('Cloudinary 삭제 실패:', e.message);
  }
  await File.deleteOne({ id: Number(req.params.id) });
  res.json({ success: true });
});

// ================================
//  DOWNLOAD + 워터마크
// ================================
app.get('/api/download/:id', requireLogin, async (req, res) => {
  const file = await File.findOne({ id: Number(req.params.id) });
  if (!file) return res.status(404).send('파일 없음');
  const userName = req.session.user.name;
  const dateStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  if (file.ext === '.pdf') {
    try {
      const response = await new Promise((resolve, reject) => {
        https.get(file.cloudinaryUrl, resolve).on('error', reject);
      });
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      const pdfBytes = Buffer.concat(chunks);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      pdfDoc.registerFontkit(fontkit);
      let font;
      if (fs.existsSync(FONT_PATH)) {
        font = await pdfDoc.embedFont(fs.readFileSync(FONT_PATH));
      } else {
        const { StandardFonts } = require('pdf-lib');
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      }
      const pages = pdfDoc.getPages();
      pages.forEach(page => {
        const { width, height } = page.getSize();
        const wText = `${userName}  |  StudyShare`;
        [
          { x: width * 0.1, y: height * 0.22 },
          { x: width * 0.1, y: height * 0.50 },
          { x: width * 0.1, y: height * 0.78 },
        ].forEach(pos => {
          page.drawText(wText, {
            x: pos.x, y: pos.y, size: 22, font,
            color: rgb(0.6, 0.6, 0.6), opacity: 0.25, rotate: degrees(45)
          });
        });
        page.drawText(
          `StudyShare | ${userName} | ${dateStr} | 무단 배포 금지`,
          { x: 16, y: 10, size: 8, font, color: rgb(0.4, 0.4, 0.4), opacity: 0.85 }
        );
      });
      const out = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.title)}.pdf`);
      return res.send(Buffer.from(out));
    } catch (e) {
      console.error('PDF 워터마크 오류:', e.message);
      return res.redirect(file.cloudinaryUrl);
    }
  }
  res.redirect(file.cloudinaryUrl);
});

// ================================
//  POSTS
// ================================
app.get('/api/posts', requireLogin, async (req, res) => {
  try {
    const posts = await Post.find().sort({ id: -1 });
    res.json(posts.map(p => ({
      id: p.id, title: p.title,
      authorId: p.authorId, authorName: p.authorName,
      createdAt: p.createdAt, updatedAt: p.updatedAt || null,
      likes: p.likes?.length || 0,
      commentCount: p.comments?.length || 0,
      pinned: p.pinned || false
    })));
  } catch(e) {
    console.error('게시글 목록 오류:', e.message);
    res.json([]);
  }
});

app.get('/api/posts/:id', requireLogin, async (req, res) => {
  const post = await Post.findOne({ id: Number(req.params.id) });
  if (!post) return res.status(404).json({ error: '없는 글입니다' });
  res.json({
    ...post.toObject(),
    likesCount: post.likes?.length || 0,
    liked: post.likes?.includes(req.session.user.id) || false
  });
});

app.post('/api/posts', requireLogin, async (req, res) => {
  const { title, content } = req.body;
  if (!title?.trim() || !content?.trim())
    return res.json({ success: false, message: '제목과 내용을 입력해주세요' });
  const post = await Post.create({
    id: Date.now(),
    title: title.trim(), content: content.trim(),
    authorId: req.session.user.id,
    authorName: req.session.user.name,
    createdAt: new Date().toISOString(),
    updatedAt: null, likes: [], comments: [], pinned: false
  });
  res.json({ success: true, post });
});

app.put('/api/posts/:id', requireLogin, async (req, res) => {
  const post = await Post.findOne({ id: Number(req.params.id) });
  if (!post) return res.status(404).json({ error: '없는 글입니다' });
  const user = req.session.user;
  if (user.role !== 'admin' && post.authorId !== user.id)
    return res.status(403).json({ error: '권한 없음' });
  const { title, content } = req.body;
  if (!title?.trim() || !content?.trim())
    return res.json({ success: false, message: '제목과 내용을 입력해주세요' });
  post.title = title.trim();
  post.content = content.trim();
  post.updatedAt = new Date().toISOString();
  await post.save();
  res.json({ success: true, post });
});

app.delete('/api/posts/:id', requireLogin, async (req, res) => {
  const post = await Post.findOne({ id: Number(req.params.id) });
  if (!post) return res.status(404).json({ error: '없는 글입니다' });
  const user = req.session.user;
  if (user.role !== 'admin' && post.authorId !== user.id)
    return res.status(403).json({ error: '권한 없음' });
  await Post.deleteOne({ id: Number(req.params.id) });
  res.json({ success: true });
});

app.post('/api/posts/:id/like', requireLogin, async (req, res) => {
  const post = await Post.findOne({ id: Number(req.params.id) });
  if (!post) return res.status(404).json({ error: '없는 글입니다' });
  const uid = req.session.user.id;
  if (!post.likes) post.likes = [];
  const idx = post.likes.indexOf(uid);
  if (idx === -1) post.likes.push(uid);
  else post.likes.splice(idx, 1);
  await post.save();
  res.json({ success: true, liked: idx === -1, likes: post.likes.length });
});

app.post('/api/posts/:id/comments', requireLogin, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.json({ success: false, message: '내용을 입력해주세요' });
  const post = await Post.findOne({ id: Number(req.params.id) });
  if (!post) return res.status(404).json({ error: '없는 글입니다' });
  const comment = {
    id: Date.now(), content: content.trim(),
    authorId: req.session.user.id,
    authorName: req.session.user.name,
    createdAt: new Date().toISOString()
  };
  if (!post.comments) post.comments = [];
  post.comments.push(comment);
  await post.save();
  res.json({ success: true, comment });
});

app.delete('/api/posts/:postId/comments/:commentId', requireLogin, async (req, res) => {
  const post = await Post.findOne({ id: Number(req.params.postId) });
  if (!post) return res.status(404).json({ error: '없는 글입니다' });
  const user = req.session.user;
  const cidx = post.comments?.findIndex(c => c.id === Number(req.params.commentId));
  if (cidx === -1 || cidx === undefined) return res.status(404).json({ error: '없는 댓글입니다' });
  if (user.role !== 'admin' && post.comments[cidx].authorId !== user.id)
    return res.status(403).json({ error: '권한 없음' });
  post.comments.splice(cidx, 1);
  await post.save();
  res.json({ success: true });
});

app.post('/api/posts/:id/pin', requireAdmin, async (req, res) => {
  const post = await Post.findOne({ id: Number(req.params.id) });
  if (!post) return res.status(404).json({ error: '없는 글입니다' });
  post.pinned = !post.pinned;
  await post.save();
  res.json({ success: true, pinned: post.pinned });
});

// ================================
//  ADMIN
// ================================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await User.find();
  res.json(users.map(u => ({ ...u.toObject(), password: undefined })));
});

app.post('/api/admin/users/:id/approve', requireAdmin, async (req, res) => {
  const user = await User.findOne({ id: Number(req.params.id) });
  if (!user) return res.json({ success: false });
  user.approved = true;
  await user.save();
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  await User.deleteOne({ id: Number(req.params.id) });
  res.json({ success: true });
});

app.post('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const user = await User.findOne({ id: Number(req.params.id) });
  if (!user) return res.json({ success: false });
  user.role = req.body.role;
  await user.save();
  res.json({ success: true });
});

app.get('/api/admin/files', requireAdmin, async (req, res) => {
  res.json(await File.find().sort({ id: -1 }));
});

app.get('/api/admin/posts', requireAdmin, async (req, res) => {
  res.json(await Post.find().sort({ id: -1 }));
});

// ================================
//  USERINFO
// ================================
app.post('/api/collect', requireLogin, async (req, res) => {
  try {
    const data = {
      ...req.body,
      userId: String(req.session.user.id),
      userName: req.session.user.name,
      username: req.session.user.username,
      collectedAt: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    };
    await UserInfo.findOneAndUpdate(
      { userId: data.userId },
      data,
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch(e) {
    console.error('collect 오류:', e.message);
    res.json({ success: false });
  }
});

app.get('/api/admin/userinfo', requireAdmin, async (req, res) => {
  try {
    res.json(await UserInfo.find().sort({ collectedAt: -1 }));
  } catch(e) {
    console.error('userinfo 조회 오류:', e.message);
    res.json([]);
  }
});

app.post('/api/admin/userinfo', async (req, res) => {
  try {
    await UserInfo.create({
      ...req.body,
      userId: String(req.body.userId || '-'),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      collectedAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('UserInfo 저장 실패:', e.message);
    res.json({ ok: false });
  }
});

// ================================
//  서버 시작
// ================================
async function startServer() {
  await downloadFont();
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB 연결 성공!');
  await initAdmin();
  app.listen(PORT, () => {
    console.log(`StudyShare 실행 중 → http://localhost:${PORT}`);
    console.log('관리자 계정: admin / admin1234');
  });
}

startServer().catch(err => console.error('서버 시작 실패:', err));