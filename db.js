const { MongoClient } = require("mongodb");

const MONGO_URL = process.env.MONGO_URL;

const client = new MongoClient(MONGO_URL, {
  tls: true,
  tlsInsecure: true,
  serverSelectionTimeoutMS: 15000,
});
let db;

// Функция для инициализации подключения к MongoDB
async function initMongo() {
  if (db) return db; // Если уже подключено, возвращаем существующую базу данных
  try {
    await client.connect();
    db = client.db("users");
    console.log("Connected to MongoDB");
    return db;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}

// Экспортируемые функции для работы с базой данных
async function getCollection(collectionName) {
  const database = await initMongo(); // Инициализация подключения
  return database.collection(collectionName);
}

module.exports = { initMongo, getCollection };
