require("dotenv").config();
const axios = require("axios");

const GHL_FILE_UPLOAD_TOKEN = process.env.GHL_FILE_UPLOAD_TOKEN || process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

if (!GHL_FILE_UPLOAD_TOKEN) {
  console.error("❌ GHL_FILE_UPLOAD_TOKEN or GHL_API_KEY environment variable is required");
  process.exit(1);
}

// Test results tracker
const results = {
  passed: [],
  failed: [],
};

function logTest(name, passed, details = "") {
  if (passed) {
    console.log(`✅ ${name}`);
    if (details) console.log(`   ${details}`);
    results.passed.push(name);
  } else {
    console.log(`❌ ${name}`);
    console.log(`   ${details}`);
    results.failed.push({ name, details });
  }
}

// First, create a test contact to use for task creation
async function createTestContact() {
  const testContact = {
    firstName: "Test",
    lastName: `V2-Task-${Date.now()}`,
    email: `test-v2-task-${Date.now()}@example.com`,
    phone: `+1555${Math.floor(Math.random() * 10000000)}`,
    tags: ["v2-task-api-test"],
    source: "V2 Task API Test Script",
  };

  try {
    // Use v1 API to create contact (we know this works)
    const axios = require("axios");
    const ghl = axios.create({
      baseURL: "https://rest.gohighlevel.com",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const res = await ghl.post("/v1/contacts/", testContact);
    const data = res.data || {};
    const contact = data.contact || data;

    if (contact && (contact.id || contact._id)) {
      return contact.id || contact._id;
    }
    return null;
  } catch (err) {
    console.error("Failed to create test contact:", err.response?.data || err.message);
    return null;
  }
}

// Test v2 API task creation - Method 1: /contacts/:contactId/tasks (as per docs)
async function testV2TaskCreationMethod1(contactId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDateStr = tomorrow.toISOString();

  const task = {
    title: "V2 API Test Task",
    body: "Testing task creation via v2 API - Method 1",
    dueDate: dueDateStr,
    completed: false, // v2 uses boolean "completed" instead of "status"
    assignedTo: null,
  };

  try {
    const url = `https://services.leadconnectorhq.com/contacts/${contactId}/tasks`;
    const res = await axios.post(url, task, {
      headers: {
        Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Version: "2021-07-28", // Required for v2 API
      },
    });

    const taskData = res.data?.task || res.data;
    if (taskData && (taskData.id || taskData._id)) {
      logTest(
        "POST /contacts/:contactId/tasks (v2)",
        true,
        `Created task: ${taskData.id || taskData._id}`
      );
      return true;
    } else {
      logTest("POST /contacts/:contactId/tasks (v2)", false, "Response missing task data");
      return false;
    }
  } catch (err) {
    logTest(
      "POST /contacts/:contactId/tasks (v2)",
      false,
      `Status: ${err.response?.status}, Error: ${JSON.stringify(err.response?.data || err.message)}`
    );
    return false;
  }
}

// Test v2 API task creation - Method 2: /tasks/ with contactId in body
async function testV2TaskCreationMethod2(contactId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDateStr = tomorrow.toISOString();

  const task = {
    title: "V2 API Test Task - Method 2",
    body: "Testing task creation via v2 API - Method 2 (contactId in body)",
    dueDate: dueDateStr,
    contactId: contactId, // contactId in body
    completed: false, // v2 uses boolean "completed" instead of "status"
    assignedTo: null,
  };

  try {
    const url = `https://services.leadconnectorhq.com/tasks/`;
    const res = await axios.post(url, task, {
      headers: {
        Authorization: `Bearer ${GHL_FILE_UPLOAD_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Version: "2021-07-28", // Required for v2 API
      },
    });

    const taskData = res.data?.task || res.data;
    if (taskData && (taskData.id || taskData._id)) {
      logTest(
        "POST /tasks/ (v2 - contactId in body)",
        true,
        `Created task: ${taskData.id || taskData._id}`
      );
      return true;
    } else {
      logTest("POST /tasks/ (v2 - contactId in body)", false, "Response missing task data");
      return false;
    }
  } catch (err) {
    logTest(
      "POST /tasks/ (v2 - contactId in body)",
      false,
      `Status: ${err.response?.status}, Error: ${JSON.stringify(err.response?.data || err.message)}`
    );
    return false;
  }
}

async function runTests() {
  console.log("🧪 Testing GHL v2 API Task Creation Endpoints\n");
  console.log(`Using Token: ${GHL_FILE_UPLOAD_TOKEN.substring(0, 10)}...`);
  console.log(`Location ID: ${GHL_LOCATION_ID || "NOT SET"}\n`);
  console.log("=" .repeat(60) + "\n");

  // Create a test contact first
  console.log("📝 Creating test contact...");
  const contactId = await createTestContact();
  if (!contactId) {
    console.log("❌ Cannot continue tests without a valid contact. Exiting.");
    return;
  }
  console.log(`✅ Created test contact: ${contactId}\n`);

  // Test Method 1: /contacts/:contactId/tasks (as per documentation)
  console.log("1️⃣  Testing POST /contacts/:contactId/tasks (v2 API)...");
  await testV2TaskCreationMethod1(contactId);
  console.log("");

  // Test Method 2: /tasks/ with contactId in body
  console.log("2️⃣  Testing POST /tasks/ (v2 API - contactId in body)...");
  await testV2TaskCreationMethod2(contactId);
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
  console.log(`\nTest Contact ID: ${contactId}`);
  console.log("\n💡 You can manually verify this contact and tasks in GHL or delete them after testing.\n");
}

// Run the tests
runTests().catch((err) => {
  console.error("❌ Unexpected error running tests:", err);
  process.exit(1);
});

