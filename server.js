{
  "name": "survive-api",
  "version": "2.0.0",
  "description": "Survive.com backend API and real-time server",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "body-parser": "^1.20.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0",
    "express": "^4.19.2",
    "stripe": "^15.0.0",
    "socket.io": "^4.7.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  }
}
