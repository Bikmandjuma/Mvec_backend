const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

// Order payloads go to rooms with very different trust levels. Anyone can
// join an `order:<id>` room or listen to /api/events, so those only receive a
// status summary. The buyer's own authenticated room gets the full order; the
// delivery code never goes to vendors, admins' broadcast or public channels.
const toPlainOrder = (order) => (order && typeof order.toJSON === "function" ? order.toJSON() : { ...(order || {}) });
const orderSummary = (order) => {
  const plain = toPlainOrder(order);
  const id = plain._id ? plain._id.toString() : plain.id;
  return {
    _id: id,
    id,
    orderNumber: plain.orderNumber,
    orderStatus: plain.orderStatus,
    paymentStatus: plain.paymentStatus,
    totalAmount: plain.totalAmount,
    updatedAt: plain.updatedAt,
  };
};
const withoutSecrets = (order) => {
  const plain = toPlainOrder(order);
  delete plain.deliveryOtp;
  return plain;
};

class SocketService {
  init(server) {
    this.io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      },
    });

    // Optional JWT Authentication for Socket Connection (allows guest buyers to track orders)
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(" ")[1];
      if (!token) {
        socket.user = { id: `guest_${socket.id}`, role: "guest" };
        return next();
      }

      try {
        // No fallback secret: a guessable default would let anyone forge a
        // token and join another user's private room.
        if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = decoded;
        next();
      } catch (err) {
        // Fallback to guest instead of blocking connection
        socket.user = { id: `guest_${socket.id}`, role: "guest" };
        next();
      }
    });

    this.io.on("connection", (socket) => {
      const userId = socket.user?.id || socket.user?.userId;
      console.log(`⚡ WebSocket Connected: ${socket.id} (User: ${userId})`);

      if (userId && !String(userId).startsWith("guest_")) {
        socket.join(`user:${userId}`);
        if (socket.user?.role === "super_admin" || socket.user?.role === "admin") {
          socket.join("admin");
        }
        if (socket.user?.role === "vendor") {
          socket.join(`vendor:${userId}`);
        }
      }

      // Join specific order room
      socket.on("join_order", (orderId) => {
        if (orderId) {
          socket.join(`order:${orderId}`);
          console.log(`Socket ${socket.id} joined order room: order:${orderId}`);
        }
      });

      // Join Dispute Room
      socket.on("join_dispute_room", (disputeId) => {
        if (disputeId) socket.join(`dispute:${disputeId}`);
      });

      // Join Live Order / Courier Tracking Room
      socket.on("join_order_tracking", (orderId) => {
        if (orderId) socket.join(`order:${orderId}`);
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

    this.sseClients = new Set();
  }

  addSseClient(res) {
    if (!this.sseClients) this.sseClients = new Set();
    this.sseClients.add(res);
  }

  removeSseClient(res) {
    if (this.sseClients) this.sseClients.delete(res);
  }

  broadcastSse(event, data) {
    if (!this.sseClients || !this.sseClients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (err) {
        this.sseClients.delete(client);
      }
    }
  }

  // Helper to emit events to specific rooms from controllers/services
  emitToRoom(room, event, data) {
    if (this.io) {
      this.io.to(room).emit(event, data);
    }
    this.broadcastSse(event, data);
  }

  // Global broadcast
  broadcast(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
    this.broadcastSse(event, data);
  }

  // Helper to notify all relevant parties about order updates
  emitOrderStatusUpdate(order) {
    const summary = orderSummary(order);
    const orderId = summary._id;
    const userId = order?.user ? (order.user._id ? order.user._id.toString() : order.user.toString()) : null;
    const internal = withoutSecrets(order);

    if (this.io) {
      this.io.to(`order:${orderId}`).emit("order_status_updated", summary);
      this.io.to(`order:${orderId}`).emit("order_updated", summary);

      if (userId) {
        this.io.to(`user:${userId}`).emit("order_status_updated", order);
        this.io.to(`user:${userId}`).emit("order_updated", order);
      }

      this.vendorIdsOf(order).forEach((vId) => {
        this.io.to(`vendor:${vId}`).emit("order_status_updated", internal);
        this.io.to(`vendor:${vId}`).emit("order_updated", internal);
        if (vId !== userId) this.io.to(`user:${vId}`).emit("order_status_updated", internal);
      });

      this.io.to("admin").emit("order_status_updated", internal);
      this.io.to("admin").emit("order_updated", internal);

      this.io.emit("dashboard_update", { type: "order", orderId, status: summary.orderStatus });
    }

    this.broadcastSse("order_status_updated", summary);
    this.broadcastSse("dashboard_update", { type: "order", orderId, status: summary.orderStatus });
  }

  emitOrderCreated(order) {
    const summary = orderSummary(order);
    const orderId = summary._id;
    const userId = order?.user ? (order.user._id ? order.user._id.toString() : order.user.toString()) : null;
    const internal = withoutSecrets(order);

    if (this.io) {
      if (userId) this.io.to(`user:${userId}`).emit("order_created", order);
      this.vendorIdsOf(order).forEach((vId) => {
        this.io.to(`vendor:${vId}`).emit("order_created", internal);
        if (vId !== userId) this.io.to(`user:${vId}`).emit("order_created", internal);
      });
      this.io.to("admin").emit("order_created", internal);
      this.io.emit("dashboard_update", { type: "new_order", orderId });
    }

    this.broadcastSse("order_created", summary);
    this.broadcastSse("dashboard_update", { type: "new_order", orderId });
  }

  vendorIdsOf(order) {
    const vendorIds = new Set();
    if (Array.isArray(order?.items)) {
      order.items.forEach((item) => {
        const vId = item.vendor ? (item.vendor._id ? item.vendor._id.toString() : item.vendor.toString()) : null;
        if (vId) vendorIds.add(vId);
      });
    }
    return vendorIds;
  }
}

SocketService.orderSummary = orderSummary;

module.exports = new SocketService();