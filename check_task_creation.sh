#!/bin/bash

# Check Task Creation: Webhook Logs and Supabase

CONTACT_ID="cx8QkqBYM13LnXkOvnQl"
WEBHOOK_URL="${APP_WEBHOOK_URL:-https://circuitous-nonstructurally-valerie.ngrok-free.dev}"

echo "🔍 ════════════════════════════════════════════════════════"
echo "🔍 CHECKING TASK CREATION"
echo "🔍 ════════════════════════════════════════════════════════"
echo ""

# 1. Check Webhook Server Health
echo "📡 Step 1: Checking webhook server health..."
curl -s "${WEBHOOK_URL}/health" | jq '.' || echo "❌ Could not reach webhook server"
echo ""

# 2. Check Supabase for CREATE_TASK events (if you have direct access)
echo "📋 Step 2: Supabase Query - Check for CREATE_TASK events"
echo "Run this in Supabase SQL Editor:"
echo ""
echo "SELECT"
echo "  id,"
echo "  event_type,"
echo "  contact_id,"
echo "  event_data,"
echo "  created_at"
echo "FROM ai_setter_events"
echo "WHERE contact_id = '${CONTACT_ID}'"
echo "AND event_type = 'create_task'"
echo "ORDER BY created_at DESC"
echo "LIMIT 5;"
echo ""

# 3. Check Supabase for created tasks
echo "📋 Step 3: Supabase Query - Check for created tasks"
echo "Run this in Supabase SQL Editor:"
echo ""
echo "SELECT"
echo "  id,"
echo "  type,"
echo "  contact_id,"
echo "  contact_name,"
echo "  assigned_to,"
echo "  status,"
echo "  trigger_event,"
echo "  metadata,"
echo "  created_at"
echo "FROM command_center_tasks"
echo "WHERE contact_id = '${CONTACT_ID}'"
echo "AND trigger_event = 'deposit_paid'"
echo "ORDER BY created_at DESC"
echo "LIMIT 5;"
echo ""

# 4. Check for artist_introduction tasks specifically
echo "📋 Step 4: Supabase Query - Check for artist_introduction tasks"
echo "Run this in Supabase SQL Editor:"
echo ""
echo "SELECT"
echo "  id,"
echo "  type,"
echo "  contact_name,"
echo "  assigned_to,"
echo "  status,"
echo "  metadata->>'consultation_type' as consultation_type,"
echo "  metadata->>'tattoo_size' as tattoo_size,"
echo "  created_at"
echo "FROM command_center_tasks"
echo "WHERE contact_id = '${CONTACT_ID}'"
echo "AND type = 'artist_introduction'"
echo "ORDER BY created_at DESC"
echo "LIMIT 1;"
echo ""

echo "✅ ════════════════════════════════════════════════════════"
echo "✅ Check complete!"
echo "✅ ════════════════════════════════════════════════════════"

