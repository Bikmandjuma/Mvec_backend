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

      // Order and dispute rooms are only for the people involved: the buyer,
      // the sellers on the order, its courier and admins (dispute: buyer,
      // seller, admins). Anyone else's join is ignored.
      const isAdmin = ["super_admin", "admin"].includes(socket.user?.role);
      const realUser = userId && !String(userId).startsWith("guest_");
      const canSeeOrder = async (orderId) => {
        if (!realUser || !/^[a-f0-9]{24}$/i.test(String(orderId || ""))) return false;
        if (isAdmin) return true;
        const order = await require("../models/Order").findById(orderId).select("user courier items.vendor").lean();
        if (!order) return false;
        const me = String(userId);
        return String(order.user) === me || String(order.courier || "") === me || (order.items || []).some((i) => String(i.vendor) === me);
      };
      const joinOrder = async (orderId) => {
        try { if (await canSeeOrder(orderId)) socket.join(`order:${orderId}`); } catch { /* ignore bad ids */ }
      };
      socket.on("join_order", joinOrder);
      socket.on("join_order_tracking", joinOrder);

      socket.on("join_dispute_room", async (disputeId) => {
        try {
          if (!realUser || !/^[a-f0-9]{24}$/i.test(String(disputeId || ""))) return;
          const dispute = await require("../models/Dispute").findById(disputeId).select("raisedBy vendor").lean();
          if (dispute && (isAdmin || [String(dispute.raisedBy), String(dispute.vendor)].includes(String(userId)))) socket.join(`dispute:${disputeId}`);
        } catch { /* ignore bad ids */ }
      });

      // Only the courier assigned to the order (or an admin) can share its location.
      socket.on("update_courier_location", async ({ orderId, latitude, longitude } = {}) => {
        try {
          const lat = Number(latitude); const lng = Number(longitude);
          if (!realUser || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
          const order = /^[a-f0-9]{24}$/i.test(String(orderId || "")) ? await require("../models/Order").findById(orderId).select("courier").lean() : null;
          if (!order || !(isAdmin || String(order.courier || "") === String(userId))) return;
          this.io.to(`order:${orderId}`).emit("courier_location_updated", { orderId, coords: { latitude: lat, longitude: lng }, timestamp: new Date() });
        } catch { /* ignore */ }
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