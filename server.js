const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://rr791337_db_user:kf8bhSmDKjcuxGJW@eenaadata.8nwhdpg.mongodb.net/votingApp?retryWrites=true&w=majority&appName=eenaadata';

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// ===== SCHEMAS =====

// User Schema (simplified - just for tracking, no auth)
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, // Can be Google ID or any identifier
  username: { type: String, required: true },
  email: { type: String },
  profilePic: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  // Interaction tracking for recommendations
  interactions: [{
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    type: { type: String, enum: ['view', 'vote', 'like', 'share'] },
    timestamp: { type: Date, default: Date.now }
  }],
  interests: [{ type: String }], // Tags user interacts with most
});

// Post Schema
const postSchema = new mongoose.Schema({
  creatorId: { type: String, required: true }, // User ID from frontend
  creatorName: { type: String, required: true },
  title: { type: String, required: true },
  image: { type: String }, // Image URL
  options: [{
    text: { type: String, required: true },
    votes: { type: Number, default: 0 },
    voters: [{ type: String }] // Array of user IDs who voted
  }],
  totalVotes: { type: Number, default: 0 },
  likes: [{ type: String }], // Array of user IDs who liked
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
postSchema.index({ creatorId: 1 });

const User = mongoose.model('User', userSchema);
const Post = mongoose.model('Post', postSchema);

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
  let user = await User.findOne({ userId });
  
  // If user doesn't exist, return trending posts
  if (!user) {
    return await Post.find()
      .sort({ trendingScore: -1, createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();
  }

  // Get user's interest tags
  const userInterests = user.interests || [];
  
  // Get IDs of posts user already interacted with
  const interactedPostIds = user.interactions.map(i => i.postId);
  
  // Build recommendation pipeline
  const posts = await Post.aggregate([
    {
      $match: {
        _id: { $nin: interactedPostIds }
      }
    },
    {
      $addFields: {
        relevanceScore: {
          $add: [
            {
              $multiply: [
                { $size: { $setIntersection: ['$tags', userInterests] } },
                10
              ]
            },
            '$trendingScore',
            {
              $divide: [
                { $subtract: [Date.now(), '$createdAt'] },
                1000000000
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
    }
  ]);

  return posts;
};

// Update trending scores
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

// ===== USER ROUTES =====

// Create or get user
app.post('/api/users', async (req, res) => {
  try {
    const { userId, username, email, profilePic } = req.body;

    if (!userId || !username) {
      return res.status(400).json({ error: 'userId and username required' });
    }

    let user = await User.findOne({ userId });

    if (!user) {
      user = new User({ userId, username, email, profilePic });
      await user.save();
    }

    res.json({ message: 'User ready', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user by ID
app.get('/api/users/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== POST ROUTES =====

// Create post
app.post('/api/posts', async (req, res) => {
  try {
    const { creatorId, creatorName, title, image, options, tags } = req.body;

    if (!creatorId || !creatorName || !title || !options) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const post = new Post({
      creatorId,
      creatorName,
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

// Get all posts (with pagination)
app.get('/api/posts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const skip = parseInt(req.query.skip) || 0;

    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    const total = await Post.countDocuments();

    res.json({ posts, total, limit, skip });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get personalized feed
app.get('/api/posts/feed/:userId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const skip = parseInt(req.query.skip) || 0;

    const posts = await getPersonalizedFeed(req.params.userId, limit, skip);

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
      .limit(limit);

    res.json({ posts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single post
app.get('/api/posts/:id', async (req, res) => {
  try {
    const { userId } = req.query;
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Track view
    post.views += 1;
    await post.save();

    // Track user interaction if userId provided
    if (userId) {
      const user = await User.findOne({ userId });
      if (user) {
        user.interactions.push({
          postId: post._id,
          type: 'view'
        });
        await user.save();
      }
    }

    res.json({ post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vote on post
app.post('/api/posts/:id/vote', async (req, res) => {
  try {
    const { optionIndex, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user already voted
    const hasVoted = post.options.some(opt => 
      opt.voters.includes(userId)
    );

    if (hasVoted) {
      return res.status(400).json({ error: 'Already voted' });
    }

    // Add vote
    post.options[optionIndex].votes += 1;
    post.options[optionIndex].voters.push(userId);
    post.totalVotes += 1;

    await post.save();

    // Track interaction and update interests
    const user = await User.findOne({ userId });
    if (user) {
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
    }

    res.json({ message: 'Vote recorded', post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Like post
app.post('/api/posts/:id/like', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const hasLiked = post.likes.includes(userId);

    if (hasLiked) {
      // Unlike
      post.likes = post.likes.filter(id => id !== userId);
      post.likesCount -= 1;
    } else {
      // Like
      post.likes.push(userId);
      post.likesCount += 1;

      // Track interaction
      const user = await User.findOne({ userId });
      if (user) {
        user.interactions.push({
          postId: post._id,
          type: 'like'
        });
        await user.save();
      }
    }

    await post.save();

    res.json({ message: hasLiked ? 'Unliked' : 'Liked', post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Share post
app.post('/api/posts/:id/share', async (req, res) => {
  try {
    const { userId } = req.body;

    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    post.shares += 1;
    await post.save();

    // Track interaction
    if (userId) {
      const user = await User.findOne({ userId });
      if (user) {
        user.interactions.push({
          postId: post._id,
          type: 'share'
        });
        await user.save();
      }
    }

    res.json({ message: 'Share recorded', post });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's posts
app.get('/api/users/:userId/posts', async (req, res) => {
  try {
    const posts = await Post.find({ creatorId: req.params.userId })
      .sort({ createdAt: -1 });

    res.json({ posts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete post
app.delete('/api/posts/:id', async (req, res) => {
  try {
    const { userId } = req.query;
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Only creator can delete
    if (post.creatorId !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await Post.findByIdAndDelete(req.params.id);

    res.json({ message: 'Post deleted' });
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
