const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = 'mongodb+srv://rr791337_db_user:kf8bhSmDKjcuxGJW@eenaadata.8nwhdpg.mongodb.net/votingApp?retryWrites=true&w=majority&appName=eenaadata';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// ===== SCHEMAS =====

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  profilePic: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  // Interaction tracking for recommendations
  interactions: [{
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    type: { type: String, enum: ['view', 'vote', 'like', 'share'] },
    timestamp: { type: Date, default: Date.now }
  }],
  interests: [{ type: String }], // Tags user interacts with most
  followedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

// Post Schema
const postSchema = new mongoose.Schema({
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  image: { type: String }, // Image URL
  options: [{
    text: { type: String, required: true },
    votes: { type: Number, default: 0 },
    voters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  }],
  totalVotes: { type: Number, default: 0 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likesCount: { type: Number, default: 0 },
  shares: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  tags: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  // Engagement metrics for recommendation algorithm
  engagementScore: { type: Number, default: 0 },
  trendingScore: { type: Number, default: 0 }
});

// Index for recommendation queries
postSchema.index({ trendingScore: -1, createdAt: -1 });
postSchema.index({ tags: 1 });
postSchema.index({ creator: 1 });

const User = mongoose.model('User', userSchema);
const Post = mongoose.model('Post', postSchema);

// ===== MIDDLEWARE =====

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ===== RECOMMENDATION ALGORITHM =====

// Calculate engagement score
const calculateEngagementScore = (post) => {
  const ageInHours = (Date.now() - post.createdAt) / (1000 * 60 * 60);
  const decayFactor = Math.exp(-ageInHours / 48); // 48-hour half-life
  
  const voteWeight = 1;
  const likeWeight = 0.5;
  const shareWeight = 2;
  const viewWeight = 0.1;
  
  const rawScore = 
    (post.totalVotes * voteWeight) +
    (post.likesCount * likeWeight) +
    (post.shares * shareWeight) +
    (post.views * viewWeight);
  
  return rawScore * decayFactor;
};

// Get personalized feed
const getPersonalizedFeed = async (userId, limit = 20, skip = 0) => {
  const user = await User.findById(userId);
  
  if (!user) {
    throw new Error('User not found');
  }

  // Get user's interest tags
  const userInterests = user.interests || [];
  
  // Get IDs of posts user already interacted with
  const interactedPostIds = user.interactions.map(i => i.postId);
  
  // Build recommendation pipeline
  const posts = await Post.aggregate([
    {
      $match: {
        _id: { $nin: interactedPostIds } // Exclude already seen posts
      }
    },
    {
      $addFields: {
        // Calculate relevance score
        relevanceScore: {
          $add: [
            // Tag matching score
            {
              $multiply: [
                { $size: { $setIntersection: ['$tags', userInterests] } },
                10
              ]
            },
            // Trending score
            '$trendingScore',
            // Recency bonus
            {
              $divide: [
                { $subtract: [Date.now(), '$createdAt'] },
                1000000000 // Scale down
              ]
            }
          ]
        }
      }
    },
    {
      $sort: { relevanceScore: -1, createdAt: -1 }
    },
    {
      $skip: skip
    },
    {
      $limit: limit
    },
    {
      $lookup: {
        from: 'users',
        localField: 'creator',
        foreignField: '_id',
        as: 'creatorInfo'
      }
    },
    {
      $unwind: '$creatorInfo'
    },
    {
      $project: {
        'creatorInfo.password': 0,
        'creatorInfo.interactions': 0
      }
    }
  ]);

  return posts;
};

// Update trending scores (run periodically)
const updateTrendingScores = async () => {
  const posts = await Post.find();
  
  for (const post of posts) {
    const engagementScore = calculateEngagementScore(post);
    await Post.findByIdAndUpdate(post._id, {
      engagementScore,
      trendingScore: engagementScore
    });
  }
};

// ===== ROUTES =====

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'Voting App API Running', status: 'OK' });
});

// ===== AUTH ROUTES =====

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      username,
      email,
      password: hashedPassword
    });

    await user.save();

    // Generate token
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { id: user._id, username, email }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET);

    res.json({
      message: 'Login successful',
      token,
      user: { id: user._id, username: user.username, email: user.email }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== POST ROUTES =====

// Create post
app.post('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { title, image, options, tags } = req.body;

    const post = new Post({
      creator: req.user.id,
      title,
      image,
      options: options.map(opt => ({ text: opt, votes: 0, voters: [] })),
      tags: tags || []
    });

    await post.save();

    res.status(201).json({ message: 'Post created', post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get personalized feed
app.get('/api/posts/feed', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const skip = parseInt(req.query.skip) || 0;

    const posts = await getPersonalizedFeed(req.user.id, limit, skip);

    res.json({ posts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get trending posts
app.get('/api/posts/trending', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    const posts = await Post.find()
      .sort({ trendingScore: -1, createdAt: -1 })
      .limit(limit)
      .populate('creator', 'username profilePic');

    res.json({ posts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single post
app.get('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('creator', 'username profilePic');

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Track view
    post.views += 1;
    await post.save();

    // Track user interaction
    await User.findByIdAndUpdate(req.user.id, {
      $push: {
        interactions: {
          postId: post._id,
          type: 'view'
        }
      }
    });

    res.json({ post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vote on post
app.post('/api/posts/:id/vote', authenticateToken, async (req, res) => {
  try {
    const { optionIndex } = req.body;
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user already voted
    const hasVoted = post.options.some(opt => 
      opt.voters.includes(req.user.id)
    );

    if (hasVoted) {
      return res.status(400).json({ error: 'Already voted' });
    }

    // Add vote
    post.options[optionIndex].votes += 1;
    post.options[optionIndex].voters.push(req.user.id);
    post.totalVotes += 1;

    await post.save();

    // Track interaction and update interests
    const user = await User.findById(req.user.id);
    user.interactions.push({
      postId: post._id,
      type: 'vote'
    });

    // Update user interests based on post tags
    post.tags.forEach(tag => {
      if (!user.interests.includes(tag)) {
        user.interests.push(tag);
      }
    });

    await user.save();

    res.json({ message: 'Vote recorded', post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Like post
app.post('/api/posts/:id/like', authenticateToken, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const hasLiked = post.likes.includes(req.user.id);

    if (hasLiked) {
      // Unlike
      post.likes = post.likes.filter(id => id.toString() !== req.user.id);
      post.likesCount -= 1;
    } else {
      // Like
      post.likes.push(req.user.id);
      post.likesCount += 1;

      // Track interaction
      await User.findByIdAndUpdate(req.user.id, {
        $push: {
          interactions: {
            postId: post._id,
            type: 'like'
          }
        }
      });
    }

    await post.save();

    res.json({ message: hasLiked ? 'Unliked' : 'Liked', post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Share post
app.post('/api/posts/:id/share', authenticateToken, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    post.shares += 1;
    await post.save();

    // Track interaction
    await User.findByIdAndUpdate(req.user.id, {
      $push: {
        interactions: {
          postId: post._id,
          type: 'share'
        }
      }
    });

    res.json({ message: 'Share recorded', post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's posts
app.get('/api/users/:id/posts', async (req, res) => {
  try {
    const posts = await Post.find({ creator: req.params.id })
      .sort({ createdAt: -1 })
      .populate('creator', 'username profilePic');

    res.json({ posts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== BACKGROUND TASKS =====

// Update trending scores every 10 minutes
setInterval(updateTrendingScores, 10 * 60 * 1000);

// ===== START SERVER =====

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;