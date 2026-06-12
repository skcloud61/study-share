require('dotenv').config();

const mongoose = require('mongoose');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const cloudinaryModule = require('cloudinary');

const cloudinary = cloudinaryModule.v2;
const app = express();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const FONTS_DIR = path.join(__dirname, 'fonts');
const FONT_PATH = path.join(FONTS_DIR, 'NotoSansKR.ttf');

if (!fs.existsSync(FONTS_DIR)) {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
}

// ================================
//  환경변수 확인
// ================================
const requiredEnv = [
  'MONGODB_URI',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error('필수 환경변수가 없습니다:', missingEnv.join(', '));
  process.exit(1);
}

if (!cloudinary || !cloudinary.uploader) {
  console.error('Cloudinary v2 로드 실패');
  console.error('cloudinaryModule keys:', Object.keys(cloudinaryModule || {}));
  process.exit(1);
}

// ================================
//  Cloudinary 설정
// ================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

console.log('Cloudinary 설정 완료');
console.log('CLOUD_NAME:', process.env.CLOUDINARY_CLOUD_NAME);

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

const User = mongoose.models.User || mongoose.model('User', UserSchema);

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

const File = mongoose.models.File || mongoose.model('File', FileSchema);

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

const Post = mongoose.models.Post || mongoose.model('Post', PostSchema);

const UserInfoSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  username: String,
  ip: String,
  collectedAt: String
}, { strict: false });

const UserInfo = mongoose.models.UserInfo || mongoose.model('UserInfo', UserInfoSchema);

// ================================
//  유틸 함수
// ================================
function formatKST(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);

  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  const ss = String(kst.getUTCSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function safeFileName(name, fallback = 'download') {
  const cleaned = String(name || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  return cleaned || fallback;
}

function encodeDownloadName(filename) {
  return encodeURIComponent(filename || 'download')
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
}

function getDownloadContentType(ext) {
  const map = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.hwp': 'application/octet-stream',
    '.hwpx': 'application/octet-stream',
    '.indd': 'application/octet-stream'
  };

  return map[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function getClientIp(req) {
  const raw =
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    '-';

  return String(raw).split(',')[0].trim();
}

function downloadFileBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (!url) {
      return reject(new Error('다운로드 URL이 없습니다.'));
    }

    if (redirectCount > 8) {
      return reject(new Error('리다이렉트가 너무 많습니다.'));
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error('잘못된 다운로드 URL입니다.'));
    }

    const client = parsedUrl.protocol === 'http:' ? http : https;

    const request = client.get(parsedUrl, {
      headers: {
        'User-Agent': 'StudyShare-Server-Downloader/1.0',
        'Accept': '*/*'
      }
    }, (response) => {
      const statusCode = response.statusCode || 0;

      if (
        statusCode >= 300 &&
        statusCode < 400 &&
        response.headers.location
      ) {
        const nextUrl = response.headers.location.startsWith('http')
          ? response.headers.location
          : new URL(response.headers.location, url).toString();

        response.resume();

        return resolve(downloadFileBuffer(nextUrl, redirectCount + 1));
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        return reject(new Error(`파일 다운로드 실패: HTTP ${statusCode}`));
      }

      const chunks = [];

      response.on('data', chunk => chunks.push(chunk));

      response.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      response.on('error', reject);
    });

    request.on('error', reject);

    request.setTimeout(1000 * 60, () => {
      request.destroy(new Error('파일 다운로드 시간이 초과되었습니다.'));
    });
  });
}

// ================================
//  폰트 다운로드
// ================================
function downloadFont() {
  return new Promise((resolve) => {
    if (fs.existsSync(FONT_PATH)) {
      return resolve();
    }

    console.log('폰트 다운로드 중...');

    const url = 'https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf';
    const file = fs.createWriteStream(FONT_PATH);

    function getUrl(u, redirectCount = 0) {
      if (redirectCount > 5) {
        console.log('폰트 다운로드 실패: 리다이렉트 초과');
        return resolve();
      }

      https.get(u, res => {
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          res.resume();
          return getUrl(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.log('폰트 다운로드 실패 HTTP:', res.statusCode);
          res.resume();
          return resolve();
        }

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('폰트 다운로드 완료');
          resolve();
        });

        file.on('error', (e) => {
          console.log('폰트 파일 저장 실패:', e.message);
          resolve();
        });
      }).on('error', (e) => {
        console.log('폰트 다운로드 실패:', e.message);
        resolve();
      });
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
      id: 1,
      username: 'admin',
      password: hash,
      name: '관리자',
      role: 'admin',
      approved: true,
      createdAt: new Date().toISOString()
    });

    console.log('admin 계정 생성 완료');
  }
}

// ================================
//  Multer + Cloudinary 업로드 설정
// ================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    try {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

      const allowed = [
        '.pdf',
        '.png',
        '.jpg',
        '.jpeg',
        '.docx',
        '.pptx',
        '.hwp',
        '.hwpx',
        '.xlsx',
        '.indd'
      ];

      const ext = path.extname(file.originalname).toLowerCase();

      if (!allowed.includes(ext)) {
        return cb(new Error('허용되지 않는 파일 형식입니다.'));
      }

      cb(null, true);
    } catch (e) {
      cb(e);
    }
  }
});

function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const publicId = Date.now() + '_' + Math.random().toString(36).slice(2) + ext;

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'studyshare',
        resource_type: 'raw',
        public_id: publicId
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }

        resolve(result);
      }
    );

    stream.on('error', reject);
    stream.end(file.buffer);
  });
}

// ================================
//  미들웨어
// ================================
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

app.use(session({
  secret: process.env.SESSION_SECRET || 'studyshare-secret-2025',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ================================
//  인증 미들웨어
// ================================
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      error: '로그인이 필요합니다'
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: '관리자 권한이 필요합니다'
    });
  }

  next();
}

// ================================
//  AUTH
// ================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ username });

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.json({
        success: false,
        message: '아이디 또는 비밀번호가 틀렸습니다.'
      });
    }

    if (!user.approved) {
      return res.json({
        success: false,
        message: '관리자 승인 대기중입니다.'
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    };

    res.json({
      success: true,
      user: req.session.user
    });
  } catch (e) {
    console.error('로그인 오류:', e.message);

    res.json({
      success: false,
      message: '로그인 중 오류가 발생했습니다.'
    });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');

    res.json({
      success: true
    });
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;

    if (!username || !password || !name) {
      return res.json({
        success: false,
        message: '모든 항목을 입력해주세요'
      });
    }

    const exists = await User.findOne({ username });

    if (exists) {
      return res.json({
        success: false,
        message: '이미 존재하는 아이디입니다.'
      });
    }

    await User.create({
      id: Date.now(),
      username,
      name,
      password: bcrypt.hashSync(password, 10),
      role: 'user',
      approved: false,
      createdAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: '가입 완료. 관리자 승인 후 사용 가능합니다.'
    });
  } catch (e) {
    console.error('회원가입 오류:', e.message);

    res.json({
      success: false,
      message: '회원가입 중 오류가 발생했습니다.'
    });
  }
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.json({
      loggedIn: false
    });
  }

  res.json({
    loggedIn: true,
    user: req.session.user
  });
});

// ================================
//  FILES
// ================================
app.get('/api/files', requireLogin, async (req, res) => {
  try {
    const files = await File.find().sort({ id: -1 });

    res.json(files.map(f => ({
      id: f.id,
      subject: f.subject,
      type: f.type,
      title: f.title,
      desc: f.desc,
      originalName: f.originalName,
      ext: f.ext,
      uploadedBy: f.uploadedBy,
      uploadedById: f.uploadedById,
      createdAt: f.createdAt
    })));
  } catch (e) {
    console.error('파일 목록 오류:', e.message);
    res.json([]);
  }
});

app.post('/api/upload', requireLogin, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('업로드 오류:', err.message || err);

      return res.json({
        success: false,
        message: '파일 업로드 실패: ' + err.message
      });
    }

    if (!req.file) {
      return res.json({
        success: false,
        message: '파일을 선택해주세요'
      });
    }

    const { subject, type, title } = req.body;
    const desc = req.body.desc || req.body.description || '';

    if (!subject || !type || !title) {
      return res.json({
        success: false,
        message: '모든 항목을 입력해주세요'
      });
    }

    try {
      const original = req.file.originalname;
      const result = await uploadToCloudinary(req.file);

      const item = await File.create({
        id: Date.now(),
        subject,
        type,
        title,
        desc: desc || '',
        originalName: original,
        savedName: result.public_id,
        cloudinaryId: result.public_id,
        cloudinaryUrl: result.secure_url,
        ext: path.extname(original).toLowerCase(),
        uploadedBy: req.session.user.name,
        uploadedById: req.session.user.id,
        createdAt: new Date().toISOString().slice(0, 10)
      });

      res.json({
        success: true,
        item
      });
    } catch (e) {
      console.error('Cloudinary 업로드 실패:', e);

      res.json({
        success: false,
        message: 'Cloudinary 업로드 실패: ' + e.message
      });
    }
  });
});

app.delete('/api/files/:id', requireLogin, async (req, res) => {
  try {
    const file = await File.findOne({
      id: Number(req.params.id)
    });

    if (!file) {
      return res.status(404).json({
        success: false,
        message: '파일을 찾을 수 없습니다.'
      });
    }

    const user = req.session.user;

    if (user.role !== 'admin' && file.uploadedById !== user.id) {
      return res.status(403).json({
        success: false,
        message: '삭제 권한이 없습니다.'
      });
    }

    if (file.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(file.cloudinaryId, {
          resource_type: 'raw'
        });
      } catch (e) {
        console.error('Cloudinary 파일 삭제 실패:', e.message);
      }
    }

    await File.deleteOne({
      id: Number(req.params.id)
    });

    res.json({
      success: true
    });
  } catch (e) {
    console.error('파일 삭제 오류:', e.message);

    res.json({
      success: false,
      message: '파일 삭제 중 오류가 발생했습니다.'
    });
  }
});

// ================================
//  DOWNLOAD + 워터마크
//  중요: Cloudinary로 redirect하지 않음.
//  서버가 Cloudinary 파일을 직접 받아서 사용자에게 내려줌.
// ================================
async function downloadHandler(req, res) {
  try {
    const file = await File.findOne({
      id: Number(req.params.id)
    });

    if (!file) {
      return res.status(404).send('파일 없음');
    }

    if (!file.cloudinaryUrl) {
      return res.status(404).send('파일 URL 없음');
    }

    const ext = String(file.ext || path.extname(file.originalName || '') || '').toLowerCase();

    let downloadName = safeFileName(
      file.originalName || file.title || 'download',
      'download'
    );

    if (ext && !downloadName.toLowerCase().endsWith(ext)) {
      downloadName += ext;
    }

    let originalBuffer;

    try {
      originalBuffer = await downloadFileBuffer(file.cloudinaryUrl);
    } catch (e) {
      console.error('Cloudinary 원본 파일 다운로드 오류:', e.message);

      if (e.message.includes('HTTP 401')) {
        return res.status(502).send(
          'Cloudinary에서 파일 접근이 차단되었습니다. Cloudinary 보안 설정을 확인해주세요.'
        );
      }

      return res.status(500).send('파일 원본을 가져오지 못했습니다: ' + e.message);
    }

    if (!originalBuffer || originalBuffer.length === 0) {
      return res.status(500).send('파일 데이터가 비어있습니다.');
    }

    // PDF가 아니면 서버가 받은 원본 파일 그대로 다운로드
    if (ext !== '.pdf') {
      res.setHeader('Content-Type', getDownloadContentType(ext));
      res.setHeader('Content-Length', originalBuffer.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeDownloadName(downloadName)}`
      );
      res.setHeader('Cache-Control', 'no-store');

      return res.send(originalBuffer);
    }

    // PDF면 워터마크 적용 시도
    try {
      const header = originalBuffer.slice(0, 20).toString('utf8');

      if (!header.includes('%PDF')) {
        console.error('PDF 확장자이지만 실제 PDF가 아닙니다. 받은 데이터 앞부분:', header);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', originalBuffer.length);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeDownloadName(downloadName)}`
        );
        res.setHeader('Cache-Control', 'no-store');

        return res.send(originalBuffer);
      }

      const user = req.session.user || {};
      const userName = user.name || '-';
      const username = user.username || '-';
      const userId = user.id || '-';
      const ip = getClientIp(req);
      const downloadedAt = formatKST();

      const pdfDoc = await PDFDocument.load(originalBuffer, {
        ignoreEncryption: true
      });

      pdfDoc.registerFontkit(fontkit);

      let koreanFont;

      try {
        if (fs.existsSync(FONT_PATH)) {
          koreanFont = await pdfDoc.embedFont(fs.readFileSync(FONT_PATH));
        } else {
          koreanFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }
      } catch (e) {
        console.error('한글 폰트 임베드 실패. Helvetica 사용:', e.message);
        koreanFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      }

      const latinFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

      pdfDoc.setTitle(file.title || 'StudyShare PDF');
      pdfDoc.setAuthor('StudyShare');
      pdfDoc.setSubject('StudyShare protected document');
      pdfDoc.setCreator('StudyShare');
      pdfDoc.setProducer('StudyShare Watermark System');
      pdfDoc.setModificationDate(new Date());

      const pages = pdfDoc.getPages();

      pages.forEach((page, index) => {
        const { width, height } = page.getSize();

        const mainWatermark = `${userName} | StudyShare`;
        const marginX = 18;
        const bottomY = 22;
        const fontSize = 6.5;

        [
          { x: width * 0.18, y: height * 0.22 },
          { x: width * 0.18, y: height * 0.50 },
          { x: width * 0.18, y: height * 0.78 }
        ].forEach(pos => {
          page.drawText(mainWatermark, {
            x: pos.x,
            y: pos.y,
            size: 18,
            font: koreanFont,
            color: rgb(0.6, 0.6, 0.6),
            opacity: 0.16,
            rotate: degrees(45)
          });
        });

        page.drawText('사용자: ', {
          x: marginX,
          y: bottomY + 36,
          size: fontSize,
          font: koreanFont,
          color: rgb(0.28, 0.28, 0.28),
          opacity: 0.85
        });

        let userLabelWidth = 34;

        try {
          userLabelWidth = koreanFont.widthOfTextAtSize('사용자: ', fontSize);
        } catch (e) {}

        page.drawText(String(userName), {
          x: marginX + userLabelWidth,
          y: bottomY + 36,
          size: fontSize,
          font: koreanFont,
          color: rgb(0.28, 0.28, 0.28),
          opacity: 0.85
        });

        page.drawText(`ID: ${username} / UID: ${userId}`, {
          x: marginX,
          y: bottomY + 24,
          size: fontSize,
          font: latinFont,
          color: rgb(0.28, 0.28, 0.28),
          opacity: 0.85
        });

        page.drawText('다운로드: ', {
          x: marginX,
          y: bottomY + 12,
          size: fontSize,
          font: koreanFont,
          color: rgb(0.28, 0.28, 0.28),
          opacity: 0.85
        });

        let downloadLabelWidth = 44;

        try {
          downloadLabelWidth = koreanFont.widthOfTextAtSize('다운로드: ', fontSize);
        } catch (e) {}

        page.drawText(downloadedAt, {
          x: marginX + downloadLabelWidth,
          y: bottomY + 12,
          size: fontSize,
          font: latinFont,
          color: rgb(0.28, 0.28, 0.28),
          opacity: 0.85
        });

        page.drawText(`IP: ${ip}`, {
          x: marginX,
          y: bottomY,
          size: fontSize,
          font: latinFont,
          color: rgb(0.28, 0.28, 0.28),
          opacity: 0.85
        });

        page.drawText('StudyShare', {
          x: marginX,
          y: bottomY - 12,
          size: fontSize,
          font: latinFont,
          color: rgb(0.35, 0.35, 0.35),
          opacity: 0.75
        });

        page.drawText(`Page ${index + 1} / ${pages.length}`, {
          x: Math.max(width - 90, marginX),
          y: bottomY - 12,
          size: fontSize,
          font: latinFont,
          color: rgb(0.35, 0.35, 0.35),
          opacity: 0.75
        });
      });

      const out = await pdfDoc.save({
        useObjectStreams: false
      });

      const outputBuffer = Buffer.from(out);

      let pdfName = safeFileName(
        file.title || file.originalName || 'StudyShare',
        'StudyShare'
      );

      if (!pdfName.toLowerCase().endsWith('.pdf')) {
        pdfName += '.pdf';
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', outputBuffer.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeDownloadName(pdfName)}`
      );
      res.setHeader('Cache-Control', 'no-store');

      return res.send(outputBuffer);
    } catch (e) {
      console.error('PDF 워터마크 오류. 원본 PDF 다운로드로 대체:', e.message);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', originalBuffer.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeDownloadName(downloadName)}`
      );
      res.setHeader('Cache-Control', 'no-store');

      return res.send(originalBuffer);
    }
  } catch (e) {
    console.error('다운로드 전체 오류:', e.message);
    return res.status(500).send('다운로드 오류: ' + e.message);
  }
}

app.get('/api/download/:id', requireLogin, downloadHandler);

// 예전 프론트 코드 호환용
app.get('/api/files/:id/download', requireLogin, downloadHandler);

// ================================
//  POSTS
// ================================
app.get('/api/posts', requireLogin, async (req, res) => {
  try {
    const posts = await Post.find().sort({ id: -1 });

    res.json(posts.map(p => ({
      id: p.id,
      title: p.title,
      authorId: p.authorId,
      authorName: p.authorName,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt || null,
      likes: p.likes?.length || 0,
      commentCount: p.comments?.length || 0,
      pinned: p.pinned || false
    })));
  } catch (e) {
    console.error('게시글 목록 오류:', e.message);
    res.json([]);
  }
});

app.get('/api/posts/:id', requireLogin, async (req, res) => {
  try {
    const post = await Post.findOne({
      id: Number(req.params.id)
    });

    if (!post) {
      return res.status(404).json({
        error: '없는 글입니다'
      });
    }

    res.json({
      ...post.toObject(),
      likesCount: post.likes?.length || 0,
      liked: post.likes?.includes(req.session.user.id) || false
    });
  } catch (e) {
    console.error('게시글 상세 오류:', e.message);

    res.status(500).json({
      error: '게시글 조회 오류'
    });
  }
});

app.post('/api/posts', requireLogin, async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title?.trim() || !content?.trim()) {
      return res.json({
        success: false,
        message: '제목과 내용을 입력해주세요'
      });
    }

    const post = await Post.create({
      id: Date.now(),
      title: title.trim(),
      content: content.trim(),
      authorId: req.session.user.id,
      authorName: req.session.user.name,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      likes: [],
      comments: [],
      pinned: false
    });

    res.json({
      success: true,
      post
    });
  } catch (e) {
    console.error('게시글 작성 오류:', e.message);

    res.json({
      success: false,
      message: '게시글 작성 오류'
    });
  }
});

app.put('/api/posts/:id', requireLogin, async (req, res) => {
  try {
    const post = await Post.findOne({
      id: Number(req.params.id)
    });

    if (!post) {
      return res.status(404).json({
        error: '없는 글입니다'
      });
    }

    const user = req.session.user;

    if (user.role !== 'admin' && post.authorId !== user.id) {
      return res.status(403).json({
        error: '권한 없음'
      });
    }

    const { title, content } = req.body;

    if (!title?.trim() || !content?.trim()) {
      return res.json({
        success: false,
        message: '제목과 내용을 입력해주세요'
      });
    }

    post.title = title.trim();
    post.content = content.trim();
    post.updatedAt = new Date().toISOString();

    await post.save();

    res.json({
      success: true,
      post
    });
  } catch (e) {
    console.error('게시글 수정 오류:', e.message);

    res.json({
      success: false,
      message: '게시글 수정 오류'
    });
  }
});

app.delete('/api/posts/:id', requireLogin, async (req, res) => {
  try {
    const post = await Post.findOne({
      id: Number(req.params.id)
    });

    if (!post) {
      return res.status(404).json({
        error: '없는 글입니다'
      });
    }

    const user = req.session.user;

    if (user.role !== 'admin' && post.authorId !== user.id) {
      return res.status(403).json({
        error: '권한 없음'
      });
    }

    await Post.deleteOne({
      id: Number(req.params.id)
    });

    res.json({
      success: true
    });
  } catch (e) {
    console.error('게시글 삭제 오류:', e.message);

    res.json({
      success: false,
      message: '게시글 삭제 오류'
    });
  }
});

app.post('/api/posts/:id/like', requireLogin, async (req, res) => {
  try {
    const post = await Post.findOne({
      id: Number(req.params.id)
    });

    if (!post) {
      return res.status(404).json({
        error: '없는 글입니다'
      });
    }

    const uid = req.session.user.id;

    if (!post.likes) {
      post.likes = [];
    }

    const idx = post.likes.indexOf(uid);

    if (idx === -1) {
      post.likes.push(uid);
    } else {
      post.likes.splice(idx, 1);
    }

    await post.save();

    res.json({
      success: true,
      liked: idx === -1,
      likes: post.likes.length
    });
  } catch (e) {
    console.error('좋아요 오류:', e.message);

    res.json({
      success: false,
      message: '좋아요 오류'
    });
  }
});

app.post('/api/posts/:id/comments', requireLogin, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content?.trim()) {
      return res.json({
        success: false,
        message: '내용을 입력해주세요'
      });
    }

    const post = await Post.findOne({
      id: Number(req.params.id)
    });

    if (!post) {
      return res.status(404).json({
        error: '없는 글입니다'
      });
    }

    const comment = {
      id: Date.now(),
      content: content.trim(),
      authorId: req.session.user.id,
      authorName: req.session.user.name,
      createdAt: new Date().toISOString()
    };

    if (!post.comments) {
      post.comments = [];
    }

    post.comments.push(comment);

    await post.save();

    res.json({
      success: true,
      comment
    });
  } catch (e) {
    console.error('댓글 작성 오류:', e.message);

    res.json({
      success: false,
      message: '댓글 작성 오류'
    });
  }
});

app.delete('/api/posts/:postId/comments/:commentId', requireLogin, async (req, res) => {
  try {
    const post = await Post.findOne({
      id: Number(req.params.postId)
    });

    if (!post) {
      return res.status(404).json({
        error: '없는 글입니다'
      });
    }

    const user = req.session.user;
    const cidx = post.comments?.findIndex(c => c.id === Number(req.params.commentId));

    if (cidx === -1 || cidx === undefined) {
      return res.status(404).json({
        error: '없는 댓글입니다'
      });
    }

    if (user.role !== 'admin' && post.comments[cidx].authorId !== user.id) {
      return res.status(403).json({
        error: '권한 없음'
      });
    }

    post.comments.splice(cidx, 1);

    await post.save();

    res.json({
      success: true
    });
  } catch (e) {
    console.error('댓글 삭제 오류:', e.message);

    res.json({
      success: false,
      message: '댓글 삭제 오류'
    });
  }
});

app.post('/api/posts/:id/pin', requireAdmin, async (req, res) => {
  try {
    const post = await Post.findOne({
      id: Number(req.params.id)
    });

    if (!post) {
      return res.status(404).json({
        error: '없는 글입니다'
      });
    }

    post.pinned = !post.pinned;

    await post.save();

    res.json({
      success: true,
      pinned: post.pinned
    });
  } catch (e) {
    console.error('고정 오류:', e.message);

    res.json({
      success: false,
      message: '고정 오류'
    });
  }
});

// ================================
//  ADMIN
// ================================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find();

    res.json(users.map(u => ({
      ...u.toObject(),
      password: undefined
    })));
  } catch (e) {
    console.error('관리자 사용자 조회 오류:', e.message);
    res.json([]);
  }
});

app.post('/api/admin/users/:id/approve', requireAdmin, async (req, res) => {
  try {
    const user = await User.findOne({
      id: Number(req.params.id)
    });

    if (!user) {
      return res.json({
        success: false
      });
    }

    user.approved = true;

    await user.save();

    res.json({
      success: true
    });
  } catch (e) {
    console.error('사용자 승인 오류:', e.message);

    res.json({
      success: false
    });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await User.deleteOne({
      id: Number(req.params.id)
    });

    res.json({
      success: true
    });
  } catch (e) {
    console.error('사용자 삭제 오류:', e.message);

    res.json({
      success: false
    });
  }
});

app.post('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const user = await User.findOne({
      id: Number(req.params.id)
    });

    if (!user) {
      return res.json({
        success: false
      });
    }

    user.role = req.body.role;

    await user.save();

    res.json({
      success: true
    });
  } catch (e) {
    console.error('권한 변경 오류:', e.message);

    res.json({
      success: false
    });
  }
});

app.get('/api/admin/files', requireAdmin, async (req, res) => {
  try {
    res.json(await File.find().sort({ id: -1 }));
  } catch (e) {
    console.error('관리자 파일 조회 오류:', e.message);
    res.json([]);
  }
});

app.get('/api/admin/posts', requireAdmin, async (req, res) => {
  try {
    res.json(await Post.find().sort({ id: -1 }));
  } catch (e) {
    console.error('관리자 게시글 조회 오류:', e.message);
    res.json([]);
  }
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
      ip: getClientIp(req)
    };

    await UserInfo.findOneAndUpdate(
      { userId: data.userId },
      data,
      {
        upsert: true,
        new: true
      }
    );

    res.json({
      success: true
    });
  } catch (e) {
    console.error('collect 오류:', e.message);

    res.json({
      success: false,
      message: e.message
    });
  }
});

app.get('/api/admin/userinfo', requireAdmin, async (req, res) => {
  try {
    const list = await UserInfo.find().sort({ collectedAt: -1 });

    res.json(list);
  } catch (e) {
    console.error('userinfo 조회 오류:', e.message);

    res.json([]);
  }
});

app.post('/api/admin/userinfo', requireAdmin, async (req, res) => {
  try {
    await UserInfo.create({
      ...req.body,
      userId: String(req.body.userId || '-'),
      ip: getClientIp(req),
      collectedAt: new Date().toISOString()
    });

    res.json({
      ok: true
    });
  } catch (e) {
    console.error('UserInfo 저장 실패:', e.message);

    res.json({
      ok: false,
      message: e.message
    });
  }
});

// ================================
//  헬스체크
// ================================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'StudyShare',
    time: new Date().toISOString()
  });
});

// ================================
//  서버 시작
// ================================
async function startServer() {
  try {
    await downloadFont();

    await mongoose.connect(process.env.MONGODB_URI);

    console.log('MongoDB 연결 성공!');

    await initAdmin();

    app.listen(PORT, () => {
      console.log(`StudyShare 실행 중 → http://localhost:${PORT}`);
      console.log('관리자 계정: admin / admin1234');
    });
  } catch (err) {
    console.error('서버 시작 실패:', err);
    process.exit(1);
  }
}

startServer();