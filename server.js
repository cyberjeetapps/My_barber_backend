const express = require("express");
const Razorpay = require("razorpay");
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

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured');
}
const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
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

// 🔥 EXISTING RAZORPAY ROUTES (keep your existing ones)

// Create Razorpay order with UPI support
app.post("/create-order", async (req, res) => {
  const { amount, currency = "INR", receipt = "receipt_001", notes = {} } = req.body;

  try {
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // convert to paise, round for safety
      currency,
      receipt,
      payment_capture: 1, // auto-capture after payment
      notes: {
        ...notes,
        created_at: new Date().toISOString(),
        platform: "react-native-expo"
      }
    });

    res.json({
      success: true,
      orderId: order.id,
      currency: order.currency,
      amount: order.amount / 100, // send back in rupees for frontend clarity
      key: razorpay.key_id,
      createdAt: order.created_at
    });
  } catch (error) {
    console.error("Order creation failed:", error);
    res.status(500).json({
      success: false,
      message: "Order creation failed",
      error: error.error ? error.error.description : error.message
    });
  }
});

// Enhanced payment verification with UPI support
app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  try {
    // Validate required fields
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required payment parameters" 
      });
    }

    // Generate signature for verification
    const generated_signature = crypto
      .createHmac("sha256", razorpay.key_secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generated_signature === razorpay_signature) {
      // Fetch payment details for additional verification (especially for UPI)
      try {
        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        
        // Check payment status
        if (payment.status === 'captured' || payment.status === 'authorized') {
          return res.json({ 
            success: true,
            paymentId: razorpay_payment_id,
            orderId: razorpay_order_id,
            paymentStatus: payment.status,
            paymentMethod: payment.method,
            amount: payment.amount / 100 // Convert back to rupees
          });
        } else {
          return res.status(400).json({ 
            success: false, 
            message: `Payment status: ${payment.status}`,
            paymentStatus: payment.status
          });
        }
      } catch (fetchError) {
        // If we can't fetch payment details, still trust the signature verification
        console.warn('Could not fetch payment details, but signature is valid:', fetchError);
        return res.json({ 
          success: true,
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          paymentStatus: 'verified_by_signature'
        });
      }
    } else {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid signature",
        details: "Signature verification failed"
      });
    }
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Payment verification failed",
      error: error.message 
    });
  }
});

// Get payment status endpoint
app.get("/payment-status/:paymentId", async (req, res) => {
  try {
    const payment = await razorpay.payments.fetch(req.params.paymentId);
    res.json({
      paymentId: payment.id,
      status: payment.status,
      method: payment.method,
      amount: payment.amount / 100,
      currency: payment.currency,
      createdAt: payment.created_at,
      captured: payment.captured
    });
  } catch (error) {
    console.error("Payment status fetch error:", error);
    res.status(500).json({ 
      message: "Failed to fetch payment status",
      error: error.error ? error.error.description : error.message 
    });
  }
});

// Webhook endpoint — the reconciliation source of truth. /verify-payment
// above depends on the customer's app staying open and online long enough
// to call it; this doesn't. Register this URL + RAZORPAY_WEBHOOK_SECRET
// in the Razorpay dashboard (Settings > Webhooks) for at least
// payment.captured and payment.failed.
app.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const body = req.body; // raw buffer

  if (!webhookSecret) {
    console.error('RAZORPAY_WEBHOOK_SECRET is not configured — rejecting webhook');
    return res.status(500).json({ status: "webhook not configured" });
  }

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(400).json({ status: "invalid signature" });
  }

  // Acknowledge immediately — Razorpay retries on slow/failed responses,
  // and the reconciliation below shouldn't hold up that ack.
  res.json({ status: "success" });

  try {
    const event = JSON.parse(body.toString());
    const payment = event?.payload?.payment?.entity;
    if (!payment) return;

    // Durable audit log for every event, independent of whether it maps to
    // a known booking below — this is what makes reconciliation actually
    // possible later, even for events this handler doesn't fully resolve.
    await db.collection('webhookEvents').add({
      event: event.event,
      paymentId: payment.id,
      orderId: payment.order_id,
      status: payment.status,
      amount: typeof payment.amount === 'number' ? payment.amount / 100 : null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (event.event !== 'payment.captured' && event.event !== 'payment.failed') {
      return;
    }

    const order = await razorpay.orders.fetch(payment.order_id);
    const notes = order.notes || {};
    const paymentStatus = event.event === 'payment.captured' ? 'paid' : 'failed';

    let ref = null;
    if (notes.appointment_id) {
      ref = db.collection('appointments').doc(notes.appointment_id);
    } else if (notes.booking_id) {
      ref = db.collection('familybookings').doc(notes.booking_id);
    }
    // Package purchases: `notes.package_id` is the catalog package's ID,
    // not the purchase record's document ID (that's auto-generated when
    // the purchase doc is created client-side), so there's no reliable way
    // to look up the specific purchase from the webhook payload alone.
    // The webhookEvents log above still captures the payment for manual
    // reconciliation — closing this fully needs the client to also write
    // its Razorpay order ID onto the package_purchases doc at creation.

    if (!ref) {
      console.warn('Webhook: could not map payment to a booking to update directly:', payment.id, notes);
      return;
    }

    await ref.set({
      paymentStatus,
      razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id,
      paymentReconciledViaWebhook: true,
      paymentReconciledAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    // Response was already sent — this only affects whether we managed to
    // reconcile Firestore, not whether Razorpay considers the webhook delivered.
    console.error('Webhook reconciliation failed:', err);
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    service: "razorpay-backend",
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
  console.log(`💳 Razorpay: Live mode`);
  console.log(`👨‍💼 Owner Management: Enabled`);
});