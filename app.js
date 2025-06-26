// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { body, validationResult } = require('express-validator');

// Configuration
const config = {
  PORT: process.env.PORT || 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'AIzaSyArRZVNQNJs5huRj2ZUM2KHbvQPsoxOUKs',
  SESSION_SECRET: process.env.SESSION_SECRET || uuidv4(),
  RATE_LIMIT_WINDOW: 15 * 60 * 1000,
  RATE_LIMIT_MAX: 100,
  MAX_SESSION_AGE: 24 * 60 * 60 * 1000,
  LOG_FILE: 'chatbot.log',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
  MAX_MESSAGE_LENGTH: 2000,
  HISTORY_LIMIT: 20
};

// Initialize Express
const app = express();
const logStream = fs.createWriteStream(path.join(__dirname, config.LOG_FILE), { flags: 'a' });

// Enhanced Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:"]
    }
  }
}));

app.use(cors({
  origin: config.CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Conversation-ID'],
  exposedHeaders: ['X-Conversation-ID']
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Session Management
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({ checkPeriod: config.MAX_SESSION_AGE }),
  cookie: {
    maxAge: config.MAX_SESSION_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Logging
app.use(morgan('combined', { stream: logStream }));

// Rate Limiting
const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW,
  max: config.RATE_LIMIT_MAX,
  message: { error: 'Too many requests, please try again later.' },
  headers: true
});

app.use('/api/', limiter);

// Session Initialization Middleware
app.use((req, res, next) => {
  if (!req.session.conversationId) {
    req.session.conversationId = uuidv4();
    req.session.conversationHistory = [];
    req.session.userPreferences = {
      responseLength: 'medium',
      formality: 'neutral',
      tone: 'friendly',
      creativity: 0.5
    };
  }
  next();
});

// Utility Functions
const utils = {
  sanitizeInput: (input) => {
    if (!input || typeof input !== 'string') return '';
    return input.trim().replace(/[<>"'`]/g, '').substring(0, config.MAX_MESSAGE_LENGTH);
  },

  buildGeminiPayload: (userMessage, preferences, history = []) => {
    const contents = history.map(entry => ({
      role: entry.role === 'user' ? 'user' : 'model',
      parts: [{ text: entry.content }]
    }));

    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    return {
      contents,
      generationConfig: {
        maxOutputTokens: preferences.responseLength === 'long' ? 1000 : 
                        preferences.responseLength === 'short' ? 200 : 500,
        temperature: preferences.creativity || 
                   (preferences.tone === 'professional' ? 0.2 : 
                    preferences.tone === 'humorous' ? 0.7 : 0.5),
        topP: 0.9,
        topK: 40
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
      ]
    };
  },

  callGeminiAPI: async (payload) => {
    const startTime = Date.now();
    try {
      const response = await fetch(`${config.GEMINI_API_URL}?key=${config.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Goog-Api-Client': 'gemini-chatbot/1.0'
        },
        body: JSON.stringify(payload)
      });

      const responseTime = Date.now() - startTime;
      console.log(`Gemini API response time: ${responseTime}ms`);

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Gemini API Error:", errorData);
        throw new Error(errorData.error?.message || 'Failed to call Gemini API');
      }

      return response.json();
    } catch (error) {
      console.error("Gemini API call failed:", error);
      throw error;
    }
  }
};

// API Endpoints
app.post('/api/chat', [
  body('message').isString().trim().notEmpty().withMessage('Message cannot be empty')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const userMessage = utils.sanitizeInput(req.body.message);
    const payload = utils.buildGeminiPayload(
      userMessage,
      req.session.userPreferences,
      req.session.conversationHistory
    );

    const geminiResponse = await utils.callGeminiAPI(payload);
    
    let aiResponse = '';
    if (geminiResponse.candidates?.[0]?.content?.parts) {
      aiResponse = geminiResponse.candidates[0].content.parts.map(part => part.text).join('\n');
    } else {
      aiResponse = "I'm sorry, I cannot provide a response to that request.";
    }

    req.session.conversationHistory.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: aiResponse }
    );

    if (req.session.conversationHistory.length > config.HISTORY_LIMIT) {
      req.session.conversationHistory = req.session.conversationHistory.slice(-config.HISTORY_LIMIT);
    }
    
    res.json({ 
      response: aiResponse, 
      conversationId: req.session.conversationId
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'An error occurred while processing your request.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/preferences', [
  body().custom(body => {
    const validValues = {
      responseLength: ['short', 'medium', 'long'],
      formality: ['casual', 'neutral', 'formal'],
      tone: ['friendly', 'professional', 'humorous'],
      creativity: (val) => !isNaN(val) && val >= 0 && val <= 1
    };

    const errors = [];
    Object.entries(body).forEach(([key, value]) => {
      if (validValues[key]) {
        if (key === 'creativity') {
          if (!validValues.creativity(value)) {
            errors.push(`Invalid ${key} value`);
          }
        } else if (!validValues[key].includes(value)) {
          errors.push(`Invalid ${key} value`);
        }
      }
    });

    if (errors.length) throw new Error(errors.join(', '));
    return true;
  })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    Object.entries(req.body).forEach(([key, value]) => {
      if (req.session.userPreferences[key] !== undefined) {
        req.session.userPreferences[key] = key === 'creativity' ? parseFloat(value) : value;
      }
    });

    res.json({ 
      success: true, 
      preferences: req.session.userPreferences 
    });
  } catch (error) {
    res.status(400).json({ 
      error: 'Invalid preferences data',
      details: error.message
    });
  }
});

app.post('/api/reset', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destruction error:', err);
      return res.status(500).json({ 
        error: 'Failed to reset conversation',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
    res.clearCookie('connect.sid');
    res.json({ 
      success: true, 
      message: 'Conversation reset successfully' 
    });
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start Server
const server = app.listen(config.PORT, () => {
  console.log(`🚀 Server running on http://localhost:${config.PORT}`);
  console.log(`🔑 Using Gemini API key: ${config.GEMINI_API_KEY.substring(0, 10)}...`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});