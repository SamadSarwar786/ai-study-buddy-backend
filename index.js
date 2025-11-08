const express = require('express');
const cors = require('cors');
const multer = require('multer');
const {GoogleGenerativeAI} = require('@google/generative-ai');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8081;

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// When running behind a reverse proxy (e.g. Vercel), trust proxy so req.ip uses X-Forwarded-For
app.set('trust proxy', 1);

app.use(
  cors({
    origin: 'https://ai-study-buddy-frontend-gamma.vercel.app',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

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
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: 'Too many requests from this IP, please try again later.',
//   standardHeaders: true,
//   legacyHeaders: false,
// });
// app.use(limiter);

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

// OCR function using Gemini Vision API (much faster for serverless)
async function extractTextFromImage(imageBuffer, mimeType) {
  try {
    console.log('Extracting text using Gemini Vision API...');

    // Use Gemini's vision model for OCR
    const model = genAI.getGenerativeModel({model: 'gemini-1.5-flash'});

    // Convert buffer to base64
    const base64Image = imageBuffer.toString('base64');

    // Determine the correct mime type format for Gemini
    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: mimeType,
      },
    };

    const prompt = 'Extract all the text from this image. Return only the text content, nothing else.';

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const extractedText = response.text();

    console.log(`Text extraction completed. Length: ${extractedText.length} characters`);

    // Clean up the extracted text
    const cleanedText = extractedText.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

    return cleanedText;
  } catch (error) {
    console.error('OCR Error Details:', {
      message: error.message,
      stack: error.stack,
      mimeType: mimeType,
    });
    throw new Error(`OCR processing failed: ${error.message}`);
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

app.get('/health', (req, res) => {
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
app.get('/test-ai', async (req, res) => {
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

// Main processing endpoint - OPTIMIZED: Single Gemini call for both OCR + AI processing
app.post('/process-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({error: 'No image file provided'});
    }

    const {requestType = 'summarize', difficulty = 'medium'} = req.body;

    console.log('Processing image with Gemini Vision API (single call)...');
    console.log(`Image info: ${req.file.mimetype}, size: ${req.file.size} bytes`);

    // Use Gemini Vision to do both OCR and AI processing in ONE call
    const model = genAI.getGenerativeModel({model: 'gemini-1.5-flash'});

    // Convert buffer to base64
    const base64Image = req.file.buffer.toString('base64');

    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: req.file.mimetype,
      },
    };

    // Build a combined prompt that extracts text AND processes it in one go
    let combinedPrompt;

    switch (requestType) {
      case 'summarize':
        combinedPrompt = `Extract all the text from this image, then summarize it in 3 key points. 
        
Format your response as JSON:
{
  "extractedText": "the full extracted text here",
  "aiResponse": "your 3-point summary here"
}`;
        break;

      case 'explain':
        combinedPrompt = `Extract all the text from this image, then explain it in simple words that are easy to understand. Break down complex concepts.
        
Format your response as JSON:
{
  "extractedText": "the full extracted text here",
  "aiResponse": "your simple explanation here"
}`;
        break;

      case 'quiz':
        combinedPrompt = `Extract all the text from this image, then generate 5 multiple-choice quiz questions with 4 options each.
        
Format your response as JSON:
{
  "extractedText": "the full extracted text here",
  "aiResponse": {
    "questions": [
      {
        "question": "Question text",
        "options": ["A", "B", "C", "D"],
        "correct": 0
      }
    ]
  }
}`;
        break;

      case 'notes':
        combinedPrompt = `Extract all the text from this image, then convert it into well-organized study notes with bullet points and key concepts highlighted.
        
Format your response as JSON:
{
  "extractedText": "the full extracted text here",
  "aiResponse": "your organized study notes here"
}`;
        break;

      default:
        combinedPrompt = `Extract all the text from this image, then analyze and explain it.
        
Format your response as JSON:
{
  "extractedText": "the full extracted text here",
  "aiResponse": "your analysis here"
}`;
    }

    // Single API call does everything!
    const result = await model.generateContent([combinedPrompt, imagePart]);
    const response = await result.response;
    const responseText = response.text();

    console.log('Gemini response received, parsing...');

    // Parse the JSON response
    let parsedResponse;
    try {
      // Clean up markdown code blocks if present
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      parsedResponse = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('Failed to parse JSON response:', parseError);
      console.log('Raw response:', responseText);
      // Fallback: try to extract text manually
      throw new Error('Failed to parse AI response. Please try again.');
    }

    const {extractedText, aiResponse} = parsedResponse;

    if (!extractedText || extractedText.trim().length < 5) {
      return res.status(400).json({
        error:
          'Could not extract meaningful text from the image. Please ensure the image contains clear, readable text and try again.',
      });
    }

    console.log(`Extracted text length: ${extractedText.length} characters`);
    console.log('AI processing completed in single call!');

    res.json({
      success: true,
      extractedText: extractedText,
      aiResponse: typeof aiResponse === 'string' ? aiResponse : JSON.stringify(aiResponse),
      requestType: requestType,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Processing error:', error);

    // Handle specific error types
    if (error.message.includes('Failed to parse')) {
      res.status(500).json({
        error: 'AI response processing failed',
        details: 'The AI returned an unexpected format. Please try again.',
        suggestion: 'If the problem persists, try with a different image.',
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
app.post('/process-text', async (req, res) => {
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
// if (process.env.NODE_ENV === 'development') {
//   app.listen(PORT, () => {
//     console.log(`🚀 AI Study Buddy server running on port ${PORT}`);
//     console.log(`📚 Ready to help students learn!`);
//   });
// }

// deployment
// const dirname1 = path.resolve();
// if (process.env.NODE_ENV === 'production') {
//   app.use(express.static(path.join(dirname1, '../client/build')));
//   app.get('*', (req, res) => {
//     res.sendFile(path.resolve(dirname1, '../client/build/index.html'));
//   });
// } else {
//   app.get('/', (req, res) => {
//     res.send('AI Study Buddy API is running!');
//   });
// }

module.exports = app;
