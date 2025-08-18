import express from "express";
import http from "http";
import mqtt from "mqtt";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// MQTT config
const client = mqtt.connect("mqtt://broker.emqx.io:1883");
const topic = "esp32/suhu";

let lastTemp = 0;

// MQTT connect
client.on("connect", () => {
  console.log("Terhubung ke MQTT broker");
  client.subscribe(topic, (err) => {
    if (!err) {
      console.log(`Subscribe ke topik: ${topic}`);
    }
  });
});

// MQTT message handler
client.on("message", (topic, message) => {
  const suhu = parseFloat(message.toString());
  lastTemp = suhu;
  console.log(`Data diterima: ${suhu} °C`);

  // broadcast ke React via Socket.IO
  io.emit("suhu", suhu);
});

// REST API untuk ambil data terakhir
app.get("/api/suhu", (req, res) => {
  res.json({ suhu: lastTemp });
});

const PORT = 5000;
server.listen(PORT, () =>
  console.log(`Server jalan di http://localhost:${PORT}`)
);
