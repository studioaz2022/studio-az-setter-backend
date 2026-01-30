require("dotenv").config();
const { createTaskForContact } = require("./src/clients/ghlClient");
const axios = require("axios");

// Create a test contact first
async function createTestContact() {
  const testContact = {
    firstName: "Test",
    lastName: `Task-Test-${Date.now()}`,
    email: `test-task-${Date.now()}@example.com`,
    phone: `+1555${Math.floor(Math.random() * 10000000)}`,
    tags: ["task-test"],
    source: "Task Test Script",
  };

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
  return contact.id || contact._id;
}

async function test() {
  console.log("🧪 Testing createTaskForContact with v2 API\n");
  
  try {
    // Create a test contact
    console.log("📝 Creating test contact...");
    const contactId = await createTestContact();
    console.log(`✅ Created contact: ${contactId}\n`);

    // Test 1: Basic task creation
    console.log("1️⃣  Testing basic task creation...");
    const task1 = await createTaskForContact(contactId, {
      title: "Test Task via Updated v2 API",
      description: "This task was created using the updated v2 API implementation",
    });
    console.log(`✅ Task created: ${task1?.task?.id || task1?.id || 'unknown'}\n`);

    // Test 2: Task with custom dueDate
    console.log("2️⃣  Testing task with custom dueDate...");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 2);
    const task2 = await createTaskForContact(contactId, {
      title: "Task with Custom Due Date",
      description: "Due in 2 days",
      dueDate: tomorrow.toISOString(),
    });
    console.log(`✅ Task created: ${task2?.task?.id || task2?.id || 'unknown'}\n`);

    // Test 3: Completed task
    console.log("3️⃣  Testing completed task...");
    const task3 = await createTaskForContact(contactId, {
      title: "Completed Task",
      description: "This task is marked as completed",
      completed: true,
    });
    console.log(`✅ Task created: ${task3?.task?.id || task3?.id || 'unknown'}\n`);

    console.log("=" .repeat(60));
    console.log("\n✅ All tests passed!");
    console.log(`\nTest Contact ID: ${contactId}`);
    console.log("💡 You can verify these tasks in GHL or delete them after testing.\n");

  } catch (err) {
    console.error("❌ Test failed:", err.response?.data || err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Response:", JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

test();

