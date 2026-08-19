const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin uses Application Default Credentials or GOOGLE_APPLICATION_CREDENTIALS.
// Initialize Firebase Admin only if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://groomy-22576.firebaseio.com"
  });
}

const db = admin.firestore();
const auth = admin.auth();
// 🔥 OWNER MANAGEMENT ROUTES

// Create owner with Firebase Auth account (admin only)
// Create owner with Firebase Auth account (admin only) - FIXED VERSION
app.post("/api/owners/create-owner", async (req, res) => {
  try {
    const {
      name,
      phoneNumber,
      email,
      bankAccountNumber,
      bankIfscCode,
      bankAccountHolderName,
      bankAccountName,
      referredByOwnerCode,
      adminToken
    } = req.body;

    // Validate required fields
    if (!name || !phoneNumber || !bankAccountNumber || !bankIfscCode || !bankAccountHolderName) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: name, phoneNumber, bankAccountNumber, bankIfscCode, bankAccountHolderName"
      });
    }

    // Verify admin token
    if (adminToken) {
      try {
        await admin.auth().verifyIdToken(adminToken);
      } catch (error) {
        return res.status(401).json({
          success: false,
          message: "Invalid admin token"
        });
      }
    }

    const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+91${phoneNumber}`;
    const authEmail = `${formattedPhone}@twilio.owner`;
    const password = formattedPhone;

    console.log('🆕 Creating owner with credentials:', {
      email: authEmail,
      password: '***' // Don't log actual password
    });

    // Create Firebase Auth user - FIXED: Don't include phoneNumber in auth creation
    let authUid;
    try {
      const userRecord = await auth.createUser({
        email: authEmail,
        password: password,
        displayName: name,
        emailVerified: false,
        disabled: false
        // 🔥 REMOVED: phoneNumber from auth creation
      });
      authUid = userRecord.uid;
      console.log('✅ Firebase auth account created:', authUid);
    } catch (authError) {
      if (authError.code === 'auth/email-already-exists') {
        // Get existing user
        const userRecord = await auth.getUserByEmail(authEmail);
        authUid = userRecord.uid;
        console.log('🔄 Using existing auth account:', authUid);
      } else {
        console.error('❌ Auth creation error:', authError);
        throw authError;
      }
    }

    // Create Firestore document
    const ownerData = {
      name,
      phoneNumber: formattedPhone,
      email: email || null,
      bankAccountNumber,
      bankIfscCode: bankIfscCode.toUpperCase(),
      bankAccountHolderName,
      bankAccountName: bankAccountName || '',
      role: 'owner',
      hasAuthAccount: true,
      authEmail: authEmail,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      shops: {},
      razorpayRegistered: false,
      // Every owner gets their own referral code to pass along to other
      // prospective owners — same pattern as the customer referral code.
      ownerReferralCode: `OW${authUid.slice(0, 6).toUpperCase()}`,
      freeAppointmentCredits: 0,
    };

    console.log('📝 Creating Firestore document with ID:', authUid);
    await db.collection('barberowner').doc(authUid).set(ownerData);

    // Owner-refers-owner: if this new owner was onboarded with another
    // owner's referral code, that owner gets 10 commission-free
    // appointment credits — checked and applied here, once, at creation
    // time, rather than guessed at after the fact.
    let referralApplied = false;
    if (referredByOwnerCode) {
      const referrerSnap = await db.collection('barberowner')
        .where('ownerReferralCode', '==', String(referredByOwnerCode).trim().toUpperCase())
        .get();
      if (!referrerSnap.empty) {
        const referrerDoc = referrerSnap.docs[0];
        if (referrerDoc.id !== authUid) {
          await referrerDoc.ref.update({
            freeAppointmentCredits: admin.firestore.FieldValue.increment(10),
          });
          referralApplied = true;
          console.log(`✅ Referral credit applied: +10 free appointments for owner ${referrerDoc.id}`);
        }
      } else {
        console.log('⚠️ Owner referral code not found, skipping credit:', referredByOwnerCode);
      }
    }

    // Verify the document was created
    const createdDoc = await db.collection('barberowner').doc(authUid).get();
    console.log('✅ Document created successfully:', createdDoc.exists);

    res.json({
      success: true,
      ownerId: authUid,
      referralApplied,
      message: "Owner created successfully with login access",
      credentials: {
        email: authEmail,
        password: formattedPhone, // Return the password for reference
        phone: formattedPhone
      },
      debug: {
        authUid: authUid,
        firestoreDocId: authUid,
        documentExists: createdDoc.exists
      }
    });

  } catch (error) {
    console.error("❌ Error creating owner:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create owner",
      error: error.message
    });
  }
});
// Update owner
app.put("/api/owners/update-owner/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { 
      name, 
      phoneNumber,
      email,
      bankAccountNumber, 
      bankIfscCode, 
      bankAccountHolderName, 
      bankAccountName,
      adminToken 
    } = req.body;

    // Verify admin token
    if (adminToken) {
      try {
        await admin.auth().verifyIdToken(adminToken);
      } catch (error) {
        return res.status(401).json({
          success: false,
          message: "Invalid admin token"
        });
      }
    }

    // Owner login looks an account up by exact phoneNumber match
    // (app/owner/login.tsx), so two owners sharing a number would make
    // login ambiguous — check for a collision before saving a correction.
    if (phoneNumber) {
      const clash = await db.collection('barberowner')
        .where('phoneNumber', '==', phoneNumber)
        .get();
      const clashesWithSomeoneElse = clash.docs.some((doc) => doc.id !== ownerId);
      if (clashesWithSomeoneElse) {
        return res.status(409).json({
          success: false,
          message: "Another owner already uses this phone number."
        });
      }
    }

    const updateData = {
      ...(name && { name }),
      ...(phoneNumber && { phoneNumber }),
      ...(email && { email }),
      ...(bankAccountNumber && { bankAccountNumber }),
      ...(bankIfscCode && { bankIfscCode: bankIfscCode.toUpperCase() }),
      ...(bankAccountHolderName && { bankAccountHolderName }),
      ...(bankAccountName && { bankAccountName }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('barberowner').doc(ownerId).update(updateData);

    res.json({
      success: true,
      message: "Owner updated successfully"
    });

  } catch (error) {
    console.error("Error updating owner:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update owner",
      error: error.message
    });
  }
});

// Delete owner
app.delete("/api/owners/delete-owner/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { adminToken } = req.body;

    // Verify admin token
    if (adminToken) {
      try {
        await admin.auth().verifyIdToken(adminToken);
      } catch (error) {
        return res.status(401).json({
          success: false,
          message: "Invalid admin token"
        });
      }
    }

    // Delete from Firestore
    await db.collection('barberowner').doc(ownerId).delete();

    // Optional: Delete from Auth (comment out if you want to keep auth account)
    try {
      await auth.deleteUser(ownerId);
      console.log('Auth account deleted:', ownerId);
    } catch (authError) {
      console.log('Auth account not found or already deleted:', authError.message);
    }

    res.json({
      success: true,
      message: "Owner deleted successfully"
    });

  } catch (error) {
    console.error("Error deleting owner:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete owner",
      error: error.message
    });
  }
});

// Get all owners
app.get("/api/owners", async (req, res) => {
  try {
    const ownersSnapshot = await db.collection('barberowner').get();
    const owners = ownersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      owners: owners
    });
  } catch (error) {
    console.error("Error fetching owners:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch owners",
      error: error.message
    });
  }
});

// Test admin SDK endpoint
app.get("/api/owners/test-admin", async (req, res) => {
  try {
    // Try to list users (first 5)
    const listUsersResult = await auth.listUsers(5);
    
    // Try to access Firestore
    const ownersSnapshot = await db.collection('barberowner').limit(5).get();
    const ownersCount = ownersSnapshot.size;

    res.json({
      success: true,
      message: "Admin SDK is working correctly",
      usersCount: listUsersResult.users.length,
      ownersCount: ownersCount,
      firebaseProject: "groomy-22576"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Admin SDK error",
      error: error.message
    });
  }
});

// 🔥 EXISTING CASHFREE ROUTES (replaced Razorpay)

const { Cashfree, CFEnvironment } = require("cashfree-pg");

const cashfreeInstance = new Cashfree();
cashfreeInstance.XClientId = process.env.CASHFREE_APP_ID || "TEST430329ae80e0f32e41a393d78b923034";
cashfreeInstance.XClientSecret = process.env.CASHFREE_SECRET_KEY || "TESTaf195616268bd6202eeb3bf8dc458956e7192a85";

// Ensure Sandbox is used if fallback TEST keys are used, to prevent authentication errors
const isProductionKeys = process.env.CASHFREE_APP_ID && !process.env.CASHFREE_APP_ID.startsWith('TEST');
cashfreeInstance.XEnvironment = (process.env.NODE_ENV === 'production' && isProductionKeys) ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;

// Create Cashfree order
app.post("/create-order", async (req, res) => {
  const { amount, currency = "INR", receipt = "receipt_001", notes = {} } = req.body;

  try {
    const orderId = receipt + "_" + Date.now(); // cashfree requires unique order_id
    const request = {
      order_amount: amount,
      order_currency: currency,
      order_id: orderId,
      customer_details: {
        customer_id: notes.customer_id || "guest",
        customer_phone: notes.phone || "9999999999",
      },
      order_meta: {
        return_url: "https://mybarber.co.in/return?order_id={order_id}"
      },
      order_tags: {
        ...notes,
        platform: "react-native-expo"
      }
    };

    cashfreeInstance.PGCreateOrder(request).then((response) => {
      let order = response.data;
      res.json({
        success: true,
        orderId: order.order_id,
        paymentSessionId: order.payment_session_id,
        currency: order.order_currency,
        amount: order.order_amount,
        createdAt: new Date().toISOString()
      });
    }).catch((error) => {
      console.error("Order creation failed:", error.response?.data || error.message);
      res.status(500).json({
        success: false,
        message: "Order creation failed",
        error: error.response?.data?.message || error.message
      });
    });
  } catch (error) {
    console.error("Order creation setup failed:", error);
    res.status(500).json({
      success: false,
      message: "Order creation setup failed",
      error: error.message
    });
  }
});

// Enhanced payment verification with UPI support
app.post("/verify-payment", async (req, res) => {
  const { order_id } = req.body;

  try {
    if (!order_id) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required payment parameters (order_id)" 
      });
      }

    cashfreeInstance.PGOrderFetchPayments(order_id).then((response) => {
      const payments = response.data;
      if (!payments || payments.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: "No payments found for this order"
        });
      }

      // Check for any successful payment
      const successfulPayment = payments.find(p => p.payment_status === "SUCCESS");

      if (successfulPayment) {
        return res.json({ 
          success: true,
          paymentId: successfulPayment.cf_payment_id,
          orderId: order_id,
          paymentStatus: "captured", // matching previous response format
          paymentMethod: successfulPayment.payment_group,
          amount: successfulPayment.payment_amount
        });
      } else {
        const lastPayment = payments[payments.length - 1];
        return res.status(400).json({ 
          success: false, 
          message: `Payment status: ${lastPayment.payment_status}`,
          paymentStatus: lastPayment.payment_status
        });
      }
    }).catch((error) => {
      console.error("Payment verification fetch error:", error.response?.data || error.message);
      res.status(500).json({ 
        success: false, 
        message: "Payment verification failed",
        error: error.response?.data?.message || error.message 
      });
    });
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Payment verification failed",
      error: error.message 
    });
  }
});

// Webhook endpoint for Cashfree (Placeholder)
app.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("Cashfree Webhook received");
  res.json({ status: "success" });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    service: "backend",
    firebase: "connected",
    features: ["payments", "owner-management"]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    message: "Internal server error",
    error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Endpoint not found" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase Project: groomy-22576`);
  console.log(`💳 Cashfree: Live mode`);
  console.log(`👨‍💼 Owner Management: Enabled`);
});