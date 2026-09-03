openapi: 3.0.0
info:
  title: MVEC Multi-Vendor Marketplace API
  description: Complete OpenAPI 3.0 specification generated from existing Express routes (Auth, Cart, Orders, Payouts, Products, and Store Profiles).
  version: 1.0.0
servers:
  - url: http://localhost:4000/api
    description: Local Development Server

paths:

  # ==========================================
  # AUTHENTICATION & PROFILE ROUTES
  # ==========================================
  /auth/register:
    post:
      summary: Register User
      tags: [Authentication]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [Fullname, email, password]
              properties:
                Fullname:
                  type: string
                  example: "John Doe"
                email:
                  type: string
                  example: "john@example.com"
                password:
                  type: string
                  example: "Password123!"
                role:
                  type: string
                  enum: [buyer, vendor]
                  default: "buyer"
      responses:
        '201':
          description: User registered successfully
        '400':
          description: Registration error or missing fields

  /auth/login:
    post:
      summary: Login User
      tags: [Authentication]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password]
              properties:
                email:
                  type: string
                  example: "user@example.com"
                password:
                  type: string
                  example: "Password123!"
      responses:
        '200':
          description: Successfully authenticated (Returns JWT)
        '401':
          description: Invalid credentials

  /auth/google-login:
    post:
      summary: Google Social OAuth Login
      tags: [Authentication]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [token]
              properties:
                token:
                  type: string
      responses:
        '200':
          description: Google authentication successful

  /auth/forgot-password:
    post:
      summary: Request Password Reset Link
      tags: [Authentication]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email]
              properties:
                email:
                  type: string
                  example: "user@example.com"
      responses:
        '200':
          description: Reset token sent to email

  /auth/reset-password/{token}:
    post:
      summary: Reset Password using Token
      tags: [Authentication]
      parameters:
        - in: path
          name: token
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [password]
              properties:
                password:
                  type: string
                  example: "NewSecurePassword123!"
      responses:
        '200':
          description: Password reset successful

  /auth/addresses:
    get:
      summary: Get User Saved Addresses
      tags: [User Addresses]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: Saved address list returned

    post:
      summary: Add New User Address
      tags: [User Addresses]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AddressInput'
      responses:
        '201':
          description: Address created

  /auth/addresses/{addressId}:
    put:
      summary: Update Address
      tags: [User Addresses]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: addressId
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AddressInput'
      responses:
        '200':
          description: Address updated

    delete:
      summary: Delete Address
      tags: [User Addresses]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: addressId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Address deleted

  # ==========================================
  # CART ROUTES
  # ==========================================
  /cart:
    get:
      summary: Fetch Shopping Cart
      tags: [Cart]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: Cart object returned

    post:
      summary: Add Item to Cart
      tags: [Cart]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [productId, quantity]
              properties:
                productId:
                  type: string
                quantity:
                  type: integer
                  example: 1
      responses:
        '200':
          description: Item added to cart

    delete:
      summary: Clear Cart
      tags: [Cart]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: Cart emptied successfully

  /cart/items/{productId}:
    put:
      summary: Update Cart Item Quantity
      tags: [Cart]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: productId
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [quantity]
              properties:
                quantity:
                  type: integer
                  example: 3
      responses:
        '200':
          description: Quantity updated

    delete:
      summary: Remove Item from Cart
      tags: [Cart]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: productId
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Item removed from cart

  # ==========================================
  # ORDER ROUTES
  # ==========================================
  /orders/checkout:
    post:
      summary: Create Checkout Order
      tags: [Orders]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [shippingAddress]
              properties:
                shippingAddress:
                  $ref: '#/components/schemas/AddressInput'
                paymentMethod:
                  type: string
                  enum: [CARD, PAYSTACK, STRIPE, CASH_ON_DELIVERY]
                  default: "CARD"
      responses:
        '201':
          description: Order created successfully

  /orders/my-orders:
    get:
      summary: Get Logged-in Buyer Orders
      tags: [Orders]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: List of buyer orders

  /orders/vendor/orders:
    get:
      summary: Get Vendor Orders (Vendor Only)
      tags: [Orders]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: List of vendor orders
        '403':
          description: Access denied

  /orders/vendor/status:
    patch:
      summary: Update Order Status (Vendor & Super Admin)
      tags: [Orders]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [orderId]
              properties:
                orderId:
                  type: string
                status:
                  type: string
                  enum: [PENDING, CONFIRMED, PROCESSING, READY_FOR_SHIPMENT, SHIPPED, DELIVERED, CANCELLED, RETURNED, REFUNDED, FAILED]
                paymentStatus:
                  type: string
                  enum: [PENDING, CONFIRMED, PAID, FAILED, REFUNDED]
      responses:
        '200':
          description: Status updated (Triggers balance calculation if DELIVERED)
        '403':
          description: Unauthorized vendor

  /orders/{id}:
    get:
      summary: Get Order Details by ID
      tags: [Orders]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Order object returned
        '404':
          description: Order not found

  # ==========================================
  # PAYOUT ROUTES
  # ==========================================
  /payouts/balance:
    get:
      summary: Get Vendor Financial Balance (Vendor Only)
      tags: [Payouts]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: Vendor ledger (availableBalance, pendingBalance, totalEarned, commissionPaid)

  /payouts/request:
    post:
      summary: Request Payout / Withdrawal (Vendor Only)
      tags: [Payouts]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount, payoutDetails]
              properties:
                amount:
                  type: number
                  example: 50000
                payoutMethod:
                  type: string
                  enum: [MOBILE_MONEY, BANK_TRANSFER]
                  default: "MOBILE_MONEY"
                payoutDetails:
                  type: object
                  required: [accountName, accountNumber]
                  properties:
                    accountName:
                      type: string
                    accountNumber:
                      type: string
                    bankName:
                      type: string
      responses:
        '201':
          description: Payout request submitted successfully
        '400':
          description: Insufficient funds

  /payouts/history:
    get:
      summary: Get Payout Request History (Vendor Only)
      tags: [Payouts]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: Vendor payout request list

  /payouts/admin/{id}/process:
    patch:
      summary: Approve or Reject Payout Request (Super Admin Only)
      tags: [Payouts (Admin)]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status]
              properties:
                status:
                  type: string
                  enum: [PAID, REJECTED]
                rejectionReason:
                  type: string
      responses:
        '200':
          description: Payout request processed
        '400':
          description: Terminal state guard (Cannot alter completed request)

  # ==========================================
  # PRODUCT ROUTES
  # ==========================================
  /products:
    get:
      summary: Get All Products (Public)
      tags: [Products]
      responses:
        '200':
          description: List of active products

    post:
      summary: Create Product (Vendor & Super Admin)
      tags: [Products]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProductInput'
      responses:
        '201':
          description: Product created successfully

  /products/slug/{slug}:
    get:
      summary: Get Product by Slug (Public)
      tags: [Products]
      parameters:
        - in: path
          name: slug
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Product details

  /products/vendor/me:
    get:
      summary: Get Logged-in Vendor's Products (Vendor Only)
      tags: [Products]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: List of products owned by vendor

  /products/{id}:
    get:
      summary: Get Product by ID (Public)
      tags: [Products]
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Product details

    put:
      summary: Update Product (Vendor & Super Admin)
      tags: [Products]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProductInput'
      responses:
        '200':
          description: Product updated

    delete:
      summary: Delete Product (Vendor & Super Admin)
      tags: [Products]
      security:
        - BearerAuth: []
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Product deleted

  # ==========================================
  # STORE ROUTES
  # ==========================================
  /stores/public/{slug}:
    get:
      summary: Get Public Store Profile and Listed Products (Public)
      tags: [Stores]
      parameters:
        - in: path
          name: slug
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Public store profile and listed items

  /stores:
    post:
      summary: Create Store Profile (Vendor Only)
      tags: [Stores]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/StoreInput'
      responses:
        '201':
          description: Store created successfully

  /stores/mine:
    get:
      summary: Get Logged-in Vendor Store Details (Vendor Only)
      tags: [Stores]
      security:
        - BearerAuth: []
      responses:
        '200':
          description: Store profile object

    put:
      summary: Update Store Details (Vendor Only)
      tags: [Stores]
      security:
        - BearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                description:
                  type: string
                contactPhone:
                  type: string
                socialLinks:
                  type: object
      responses:
        '200':
          description: Store updated successfully

# ==========================================
# REUSABLE COMPONENTS
# ==========================================
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    AddressInput:
      type: object
      required: [street, city, state, country]
      properties:
        street:
          type: string
          example: "KN 5 Rd"
        city:
          type: string
          example: "Kigali"
        state:
          type: string
          example: "Kigali City"
        country:
          type: string
          example: "Rwanda"
        postalCode:
          type: string
          example: "00250"

    ProductInput:
      type: object
      required: [name, price, stockQuantity]
      properties:
        name:
          type: string
          example: "Wireless Headphones"
        description:
          type: string
        price:
          type: number
          example: 45000
        stockQuantity:
          type: integer
          example: 20
        category:
          type: string
          example: "Electronics"
        status:
          type: string
          enum: [ACTIVE, INACTIVE, OUT_OF_STOCK]
          default: "ACTIVE"

    StoreInput:
      type: object
      required: [storeName, contactEmail, contactPhone]
      properties:
        storeName:
          type: string
          example: "Kigali Tech Hub"
        description:
          type: string
        businessCategory:
          type: string
          example: "Electronics"
        contactEmail:
          type: string
          example: "support@kigalitech.rw"
        contactPhone:
          type: string
          example: "+250788123456"
        address:
          $ref: '#/components/schemas/AddressInput'