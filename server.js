require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// =====================
// APP INIT
// =====================
const app = express();

// =====================
// MIDDLEWARE
// =====================
app.use(cors());
app.use(express.json());

// =====================
// DB CONNECTION
// =====================
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing in .env');
  process.exit(1);
}

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// =====================
// SCHEMAS
// =====================

// User Schema
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  email: { type: String },
  profilePic: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  interactions: [{
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    type: { type: String, enum: ['view', 'vote', 'like', 'share'] },
    timestamp: { type: Date, default: Date.now }
  }],
  interests: [{ type: String }],
});

// Post Schema
const postSchema = new mongoose.Schema({
  creatorId: { type: String, required: true },
  creatorName: { type: String, required: true },
  title: { type: String, required: true },
  image: { type: String },
  options: [{
    text: { type: String, required: true },
    votes: { type: Number, default: 0 },
    voters: [{ type: String }]
  }],
  totalVotes: { type: Number, default: 0 },
  likes: [{ type: String }],
  likesCount: { type: Number, default: 0 },
  shares: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  tags: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  engagementScore: { type: Number, default: 0 },
  trendingScore: { type: Number, default: 0 }
});

postSchema.index({ trendingScore: -1, createdAt: -1 });
postSchema.index({ tags: 1 });
postSchema.index({ creatorId: 1 });

const User = mongoose.model('User', userSchema);
const Post = mongoose.model('Post', postSchema);

// =====================
// RECOMMENDATION LOGIC
// =====================

const calculateEngagementScore = (post) => {
  const ageInHours = (Date.now() - post.createdAt) / (1000 * 60 * 60);
  const decayFactor = Math.exp(-ageInHours / 48);

  const rawScore =
    post.totalVotes * 1 +
    post.likesCount * 0.5 +
    post.shares * 2 +
    post.views * 0.1;

  return rawScore * decayFactor;
};

const getPersonalizedFeed = async (userId, limit = 20, skip = 0) => {
  const user = await User.findOne({ userId });

  if (!user) {
    return Post.find()
      .sort({ trendingScore: -1, createdAt: -1 })
      .limit(limit)
      .skip(skip);
  }

  const interactedPostIds = user.interactions.map(i => i.postId);
  const userInterests = user.interests || [];

  return Post.aggregate([
    { $match: { _id: { $nin: interactedPostIds } } },
    {
      $addFields: {
        relevanceScore: {
          $add: [
            { $multiply: [{ $size: { $setIntersection: ['$tags', userInterests] } }, 10] },
            '$trendingScore'
          ]
        }
      }
    },
    { $sort: { relevanceScore: -1, createdAt: -1 } },
    { $skip: skip },
    { $limit: limit }
  ]);
};

const updateTrendingScores = async () => {
  const posts = await Post.find();
  for (const post of posts) {
    const score = calculateEngagementScore(post);
    await Post.findByIdAndUpdate(post._id, {
      engagementScore: score,
      trendingScore: score
    });
  }
};

// =====================
// ROUTES
// =====================

// Health
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Voting App API Running' });
});

// Create/Get User
app.post('/api/users', async (req, res) => {
  try {
    const { userId, username, email, profilePic } = req.body;
    if (!userId || !username) {
      return res.status(400).json({ error: 'userId & username required' });
    }

    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, username, email, profilePic });
      await user.save();
    }

    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create Post
app.post('/api/posts', async (req, res) => {
  try {
    const { creatorId, creatorName, title, image, options, tags } = req.body;

    const post = new Post({
      creatorId,
      creatorName,
      title,
      image,
      options: options.map(o => ({ text: o })),
      tags: tags || []
    });

    await post.save();
    res.status(201).json({ post });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Posts
app.get('/api/posts', async (req, res) => {
  const limit = +req.query.limit || 20;
  const skip = +req.query.skip || 0;

  const posts = await Post.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);

  res.json({ posts });
});

// Vote
app.post('/api/posts/:id/vote', async (req, res) => {
  try {
    const { optionIndex, userId } = req.body;
    const post = await Post.findById(req.params.id);

    if (!post) return res.status(404).json({ error: 'Post not found' });

    if (post.options.some(o => o.voters.includes(userId))) {
      return res.status(400).json({ error: 'Already voted' });
    }

    post.options[optionIndex].votes++;
    post.options[optionIndex].voters.push(userId);
    post.totalVotes++;

    await post.save();
    res.json({ post });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Like
app.post('/api/posts/:id/like', async (req, res) => {
  try {
    const { userId } = req.body;
    const post = await Post.findById(req.params.id);

    const idx = post.likes.indexOf(userId);
    if (idx > -1) {
      post.likes.splice(idx, 1);
      post.likesCount--;
    } else {
      post.likes.push(userId);
      post.likesCount++;
    }

    await post.save();
    res.json({ post });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

setInterval(updateTrendingScores, 10 * 60 * 1000);

// =====================
// SERVER
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
