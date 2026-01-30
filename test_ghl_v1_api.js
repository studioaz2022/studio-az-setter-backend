require("dotenv").config();
const axios = require("axios");

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

if (!GHL_API_KEY) {
  console.error("❌ GHL_API_KEY environment variable is required");
  process.exit(1);
}

// Axios client for GHL v1 API
const ghl = axios.create({
  baseURL: "https://rest.gohighlevel.com",
  headers: {
    Authorization: `Bearer ${GHL_API_KEY}`,
    "Content-Type": "application/json",
  },
});

// Test results tracker
const results = {
  passed: [],
  failed: [],
};

function logTest(name, passed, details = "") {
  if (passed) {
    console.log(`✅ ${name}`);
    results.passed.push(name);
  } else {
    console.log(`❌ ${name}`);
    console.log(`   ${details}`);
    results.failed.push({ name, details });
  }
}

async function testGetContact(contactId) {
  try {
    const res = await axios.get(
      `https://rest.gohighlevel.com/v1/contacts/${contactId}`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Accept: "application/json",
        },
      }
    );

    const data = res.data || {};
    const contact = data.contact || data;

    if (contact && (contact.id || contact._id)) {
      logTest("GET /v1/contacts/{contactId}", true, `Found contact: ${contact.id || contact._id}`);
      return contact;
    } else {
      logTest("GET /v1/contacts/{contactId}", false, "Response missing contact data");
      return null;
    }
  } catch (err) {
    logTest(
      "GET /v1/contacts/{contactId}",
      false,
      `Status: ${err.response?.status}, Error: ${err.response?.data?.message || err.message}`
    );
    return null;
  }
}

async function testLookupContactByEmail(email) {
  try {
    const res = await ghl.get("/v1/contacts/lookup", {
      params: { email },
    });

    const data = res.data || {};
    const contacts = data.contacts || [];
    const contact = data.contact || (contacts.length > 0 ? contacts[0] : null) || data;

    if (contact && (contact.id || contact._id)) {
      logTest("GET /v1/contacts/lookup?email={email}", true, `Found contact: ${contact.id || contact._id}`);
      return contact.id || contact._id;
    } else {
      logTest("GET /v1/contacts/lookup?email={email}", false, "No contact found");
      return null;
    }
  } catch (err) {
    logTest(
      "GET /v1/contacts/lookup?email={email}",
      false,
      `Status: ${err.response?.status}, Error: ${err.response?.data?.message || err.message}`
    );
    return null;
  }
}

async function testCreateContact() {
  const testContact = {
    firstName: "Test",
    lastName: `V1-API-${Date.now()}`,
    email: `test-v1-api-${Date.now()}@example.com`,
    phone: `+1555${Math.floor(Math.random() * 10000000)}`,
    tags: ["v1-api-test"],
    source: "V1 API Test Script",
  };

  try {
    const res = await ghl.post("/v1/contacts/", testContact);
    const data = res.data || {};
    const contact = data.contact || data;

    if (contact && (contact.id || contact._id)) {
      const contactId = contact.id || contact._id;
      logTest("POST /v1/contacts/", true, `Created contact: ${contactId}`);
      return { contactId, email: testContact.email, phone: testContact.phone };
    } else {
      logTest("POST /v1/contacts/", false, "Response missing contact ID");
      return null;
    }
  } catch (err) {
    logTest(
      "POST /v1/contacts/",
      false,
      `Status: ${err.response?.status}, Error: ${JSON.stringify(err.response?.data || err.message)}`
    );
    return null;
  }
}

async function testUpdateContact(contactId) {
  const updateData = {
    tags: ["v1-api-test", "updated"],
    customField: {
      // Add a test note in a custom field if you have one
    },
  };

  try {
    const res = await ghl.put(`/v1/contacts/${contactId}`, updateData);
    const data = res.data || {};
    const contact = data.contact || data;

    if (contact && (contact.id || contact._id)) {
      logTest("PUT /v1/contacts/{contactId}", true, `Updated contact: ${contactId}`);
      return true;
    } else {
      logTest("PUT /v1/contacts/{contactId}", false, "Response missing contact data");
      return false;
    }
  } catch (err) {
    logTest(
      "PUT /v1/contacts/{contactId}",
      false,
      `Status: ${err.response?.status}, Error: ${JSON.stringify(err.response?.data || err.message)}`
    );
    return false;
  }
}

async function testCreateTask(contactId) {
  // Set dueDate to tomorrow (required field) - format as ISO string with Z timezone
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  // Format: YYYY-MM-DDTHH:mm:ssZ (e.g., "2020-10-25T10:00:00Z")
  const dueDateStr = tomorrow.toISOString().replace(/\.\d{3}/, '');
  
  // Match the actual implementation - it uses "open" but might need dueDate in specific format
  // The actual code sets dueDate to null if not provided, but API requires it
  const task = {
    title: "V1 API Test Task",
    description: "Testing task creation via v1 API",
    status: "open", // Match actual implementation
    dueDate: dueDateStr,
    assignedTo: null,
  };
  
  // Note: If this fails, it might be that the v1 API task endpoint has different requirements
  // or the status values have changed. The actual codebase uses this same format.

  try {
    const res = await ghl.post(`/v1/contacts/${contactId}/tasks`, task);
    const data = res.data || {};
    const taskData = data.task || data;

    if (taskData && (taskData.id || taskData._id)) {
      logTest("POST /v1/contacts/{contactId}/tasks", true, `Created task: ${taskData.id || taskData._id}`);
      return true;
    } else {
      logTest("POST /v1/contacts/{contactId}/tasks", false, "Response missing task data");
      return false;
    }
  } catch (err) {
    logTest(
      "POST /v1/contacts/{contactId}/tasks",
      false,
      `Status: ${err.response?.status}, Error: ${JSON.stringify(err.response?.data || err.message)}`
    );
    return false;
  }
}

async function runTests() {
  console.log("🧪 Testing GHL v1 API Endpoints\n");
  console.log(`Using API Key: ${GHL_API_KEY.substring(0, 10)}...`);
  console.log(`Location ID: ${GHL_LOCATION_ID || "NOT SET"}\n`);
  console.log("=" .repeat(60) + "\n");

  // Test 1: Create a contact (we'll use this for other tests)
  console.log("1️⃣  Testing POST /v1/contacts/ (create contact)...");
  const created = await testCreateContact();
  console.log("");

  if (!created) {
    console.log("❌ Cannot continue tests without a valid contact. Exiting.");
    return;
  }

  const testContactId = created.contactId;
  const testEmail = created.email;
  const testPhone = created.phone;

  // Test 2: Get the contact we just created
  console.log("2️⃣  Testing GET /v1/contacts/{contactId}...");
  await testGetContact(testContactId);
  console.log("");

  // Test 3: Lookup by email
  console.log("3️⃣  Testing GET /v1/contacts/lookup?email={email}...");
  await testLookupContactByEmail(testEmail);
  console.log("");

  // Test 4: Update the contact
  console.log("4️⃣  Testing PUT /v1/contacts/{contactId}...");
  await testUpdateContact(testContactId);
  console.log("");

  // Test 5: Create a task
  console.log("5️⃣  Testing POST /v1/contacts/{contactId}/tasks...");
  await testCreateTask(testContactId);
  console.log("");

  // Summary
  console.log("=" .repeat(60));
  console.log("\n📊 Test Summary:");
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  console.log("");

  if (results.failed.length > 0) {
    console.log("Failed Tests:");
    results.failed.forEach(({ name, details }) => {
      console.log(`  ❌ ${name}`);
      console.log(`     ${details}`);
    });
  }

  console.log("\n" + "=" .repeat(60));
  console.log(`\nTest Contact ID: ${testContactId}`);
  console.log(`Test Email: ${testEmail}`);
  console.log(`Test Phone: ${testPhone}`);
  console.log("\n💡 You can manually verify this contact in GHL or delete it after testing.\n");
}

// Run the tests
runTests().catch((err) => {
  console.error("❌ Unexpected error running tests:", err);
  process.exit(1);
});

