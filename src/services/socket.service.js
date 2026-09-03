const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

class SocketService {
  init(server) {
    this.io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    // JWT Authentication Middleware for Socket Connection
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(" ")[1];
      if (!token) return next(new Error("Authentication error: No token provided"));

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "test_secret_key");
        socket.user = decoded;
        next();
      } catch (err) {
        return next(new Error("Authentication error: Invalid token"));
      }
    });

    this.io.on("connection", (socket) => {
      console.log(`⚡ WebSocket Connected: ${socket.id} (User: ${socket.user.id})`);

      // Join User-Specific Private Channel
      socket.join(`user:${socket.user.id}`);

      // Join Dispute Room
      socket.on("join_dispute_room", (disputeId) => {
        socket.join(`dispute:${disputeId}`);
      });

      // Join Live Order / Courier Tracking Room
      socket.on("join_order_tracking", (orderId) => {
        socket.join(`order:${orderId}`);
      });

      // Realtime Courier Location Stream
      socket.on("update_courier_location", ({ orderId, latitude, longitude }) => {
        this.io.to(`order:${orderId}`).emit("courier_location_updated", {
          orderId,
          coords: { latitude, longitude },
          timestamp: new Date(),
        });
      });

      socket.on("disconnect", () => {
        console.log(`🔌 WebSocket Disconnected: ${socket.id}`);
      });
    });
  }

  // Helper to emit events to specific rooms from controllers/services
  emitToRoom(room, event, data) {
    if (this.io) {
      this.io.to(room).emit(event, data);
    }
  }
}

module.exports = new SocketService();