const express = require('express');
const cors = require('cors');
const multer = require('multer');
const {createWorker} = require('tesseract.js');
const {GoogleGenerativeAI} = require('@google/generative-ai');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8081;

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// app.use(
//   cors({
//     origin: 'http://localhost:3000',
//     methods: ['GET', 'POST', 'OPTIONS'],
//     allowedHeaders: ['Content-Type'],
//   })
// );

// // also handle preflight
// app.options('*', (req, res) => {
//   res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
//   res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
//   res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
//   res.header('Access-Control-Allow-Credentials', 'true');
//   res.sendStatus(200);
// });
// app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.urlencoded({extended: true, limit: '10mb'}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});
app.use(limiter);

async function listGeminiModels() {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_AI_API_KEY}`;

  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Failed to list models: ${err.error || resp.status}`);
  }

  const data = await resp.json();
  return data; // it will have `models` or similar field
}

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow common image formats
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/tiff'];

    if (allowedMimes.includes(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(
        new Error(`Unsupported image format: ${file.mimetype}. Please use JPEG, PNG, GIF, BMP, WebP, or TIFF.`),
        false
      );
    }
  },
});

// OCR function
async function extractTextFromImage(imageBuffer, mimeType) {
  let worker;

  try {
    console.log('Creating Tesseract worker...');

    // Create worker with minimal configuration to avoid errors
    worker = await createWorker('eng');

    console.log('Worker created, starting recognition...');

    // Process the image with minimal parameters
    const {
      data: {text, confidence},
    } = await worker.recognize(imageBuffer);

    console.log(`OCR completed. Confidence: ${confidence}%`);

    // Clean up the extracted text
    const cleanedText = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

    return cleanedText;
  } catch (error) {
    console.error('OCR Error Details:', {
      message: error.message,
      stack: error.stack,
      mimeType: mimeType,
    });
    throw new Error(`OCR processing failed: ${error.message}`);
  } finally {
    if (worker) {
      try {
        await worker.terminate();
        console.log('Worker terminated successfully');
      } catch (terminateError) {
        console.error('Error terminating worker:', terminateError);
      }
    }
  }
}

// AI processing function
async function processTextWithAI(text, requestType = 'summarize', difficulty = 'medium') {
  try {
    // Get available models and find the best one
    // const modelsData = await listGeminiModels();
    // const availableModels = modelsData.models || [];

    // // Try different model names in order of preference
    // const preferredModels = [
    //   'models/gemini-1.5-pro',
    //   'models/gemini-1.5-flash',
    //   'models/gemini-pro',
    //   'models/gemini-1.0-pro'
    // ];

    let workingModel = 'models/gemini-2.5-flash-image-preview';
    // for (const modelName of preferredModels) {
    //   const found = availableModels.find(m => m.name === modelName);
    //   if (found && found.supportedGenerationMethods?.includes('generateContent')) {
    //     workingModel = modelName;
    //     console.log(`Using model: ${modelName}`);
    //     break;
    //   }
    // }

    if (!workingModel) {
      throw new Error('No suitable models found for text generation');
    }

    console.log(`Using model: ${workingModel}`);

    const model = genAI.getGenerativeModel({model: workingModel});

    console.log('Model created');

    let prompt;

    switch (requestType) {
      case 'summarize':
        prompt = `Please summarize the following text in 3 key points. Make it clear and concise:
  
        ${text}`;
        break;

      case 'explain':
        prompt = `Please explain the following text in simple words that are easy to understand. Break down complex concepts:

        ${text}`;
        break;

      case 'quiz':
        prompt = `Based on the following text, generate 5 multiple-choice quiz questions with 4 options each. Include the correct answer for each question. Format as JSON with this structure:
         {
        "questions": [
          {
            "question": "Question text",
            "options": ["A", "B", "C", "D"],
            "correct": 0
          }
        ] 
      }

       Text: ${text}`;
        break;

      case 'notes':
        prompt = `Convert the following text into well-organized study notes with bullet points and key concepts highlighted:

      ${text}`;
        break;

      default:
        prompt = `Please analyze and explain the following text:

        ${text}`;
    }

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('AI processing error:', error);
    throw new Error('Failed to process text with AI');
  }
}

// // Routes
// app.get('/', (req, res) => {
//   res.json({message: 'AI Study Buddy API is running!'});
// });

app.get('/api/health', (req, res) => {
  res.json({status: 'OK', timestamp: new Date().toISOString()});
});

// Debug endpoint to list available models
app.get('/models', async (req, res) => {
  try {
    const models = await listGeminiModels();
    res.json({
      models: models.models.map((model) => ({
        name: model.name,
        displayName: model.displayName,
        supportedGenerationMethods: model.supportedGenerationMethods,
      })),
    });
  } catch (error) {
    console.error('Error listing models:', error);
    res.status(500).json({error: 'Failed to list models', details: error.message});
  }
});

// Test endpoint for Google AI API
app.get('/api/test-ai', async (req, res) => {
  try {
    console.log('Testing Google AI API...');
    console.log('API Key exists:', !!process.env.GOOGLE_AI_API_KEY);
    console.log('API Key length:', process.env.GOOGLE_AI_API_KEY?.length || 0);

    // Get available models first
    const modelsData = await listGeminiModels();
    const availableModels = modelsData.models || [];

    // Find a working model
    let workingModel = null;
    const testModels = ['models/gemini-1.5-flash', 'models/gemini-1.5-pro', 'models/gemini-pro'];

    for (const testModel of testModels) {
      const found = availableModels.find((m) => m.name === testModel);
      if (found && found.supportedGenerationMethods?.includes('generateContent')) {
        workingModel = testModel;
        break;
      }
    }

    if (!workingModel) {
      return res.json({
        error: 'No suitable model found',
        availableModels: availableModels.map((m) => ({
          name: m.name,
          methods: m.supportedGenerationMethods,
        })),
      });
    }

    // Try the simplest possible request with the working model
    const model = genAI.getGenerativeModel({model: workingModel});
    const result = await model.generateContent('Hello, world!');
    const response = await result.response;
    const text = response.text();

    res.json({
      success: true,
      response: text,
      model: workingModel,
      availableModels: availableModels.length,
    });
  } catch (error) {
    console.error('AI test error:', error);
    res.status(500).json({
      error: 'AI test failed',
      details: error.message,
      stack: error.stack,
    });
  }
});

// Main processing endpoint
app.post('/api/process-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({error: 'No image file provided'});
    }

    const {requestType = 'summarize', difficulty = 'medium'} = req.body;

    // Extract text from image using OCR
    console.log('Extracting text from image...');
    console.log(`Image info: ${req.file.mimetype}, size: ${req.file.size} bytes`);

    // Add a small delay to ensure proper initialization
    await new Promise((resolve) => setTimeout(resolve, 100));

    const extractedText = await extractTextFromImage(req.file.buffer, req.file.mimetype);

    if (!extractedText || extractedText.trim().length < 5) {
      return res.status(400).json({
        error:
          'Could not extract meaningful text from the image. Please ensure the image contains clear, readable text and try again.',
      });
    }

    console.log(`Extracted text length: ${extractedText.length} characters`);

    console.log('Processing text with AI...');
    // Process text with Google AI
    const aiResponse = await processTextWithAI(extractedText, requestType, difficulty);

    res.json({
      success: true,
      extractedText: extractedText,
      aiResponse: aiResponse,
      requestType: requestType,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Processing error:', error);

    // Handle specific error types
    if (error.message.includes('OCR processing failed')) {
      res.status(400).json({
        error: 'Failed to extract text from image',
        details: 'The image may be unclear, corrupted, or contain no readable text. Please try a different image.',
        suggestion: 'Ensure the image is clear, well-lit, and contains readable text.',
      });
    } else if (error.message.includes('Failed to process text with AI')) {
      res.status(500).json({
        error: 'AI processing failed',
        details: 'There was an issue processing your text with AI. Please try again.',
        suggestion: 'If the problem persists, try with a shorter text or different image.',
      });
    } else {
      res.status(500).json({
        error: 'Failed to process image',
        details: error.message,
        suggestion: 'Please try again with a different image or contact support if the issue persists.',
      });
    }
  }
});

// Text-only processing endpoint (for when user wants to process extracted text differently)
app.post('/api/process-text', async (req, res) => {
  try {
    const {text, requestType = 'summarize', difficulty = 'medium'} = req.body;

    if (!text || text.trim().length < 10) {
      return res.status(400).json({error: 'Text is too short or empty'});
    }

    const aiResponse = await processTextWithAI(text, requestType, difficulty);

    res.json({
      success: true,
      aiResponse: aiResponse,
      requestType: requestType,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Text processing error:', error);
    res.status(500).json({
      error: 'Failed to process text',
      details: error.message,
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({error: 'File too large. Maximum size is 10MB.'});
    }
  }

  console.error('Unhandled error:', error);
  res.status(500).json({error: 'Internal server error'});
});

// 404 handler
// app.use('*', (req, res) => {
//   res.status(404).json({error: 'Route not found'});
// });
if (process.env.NODE_ENV === 'development') {
  app.listen(PORT, () => {
    console.log(`🚀 AI Study Buddy server running on port ${PORT}`);
    console.log(`📚 Ready to help students learn!`);
  });
}

// deployment
const dirname1 = path.resolve();
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(dirname1, '../client/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(dirname1, '../client/build/index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('AI Study Buddy API is running!');
  });
}

module.exports = app;
