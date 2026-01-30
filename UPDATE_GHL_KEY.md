# Update GHL API Key on Render

## Current (Expired) Key:
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsb2NhdGlvbl9pZCI6Im1VZW14MmpHNHdseTRrSldCa0k0IiwidmVyc2lvbiI6MSwiaWF0IjoxNzU5NzgxMzI0OTc1LCJzdWIiOiIxa0ZHNUZXZFVEaFhMVVg0NnNuRyJ9.AGU63G-fgQhUQinazgFugis3IPD-Z94d3ALuz8Qixng
```

## Correct Key:
```
pit-e90ab0bc-d2c3-4d09-ae5a-4fb9c42138ee
```

## Steps to Update on Render:

1. Go to: https://dashboard.render.com/
2. Select your service: `studio-az-setter-backend`
3. Go to **Environment** tab
4. Find the `GHL_API_KEY` variable
5. Update the value to: `pit-e90ab0bc-d2c3-4d09-ae5a-4fb9c42138ee`
6. Click **Save Changes**
7. Render will automatically redeploy with the new key

## Test the New Key

After updating, you can test if the key works:

```bash
curl -X GET 'https://services.leadconnectorhq.com/contacts/cx8QkqBYM13LnXkOvnQl' \
  -H 'Authorization: Bearer pit-e90ab0bc-d2c3-4d09-ae5a-4fb9c42138ee' \
  -H 'Version: 2021-07-28'
```

This should return the contact details without a 401 error.

## What This Will Fix

With the correct API key:
1. ✅ Custom field reads will work (consultation_type, tattoo_size, assigned_artist)
2. ✅ Custom field writes will work (financial tracking fields)
3. ✅ The correct task type will be created (artist_introduction for message consults)
4. ✅ Contact updates will succeed

---

## After Render Redeploys

Once Render redeploys with the new key (~2 minutes), create a fresh test:

```bash
cd /Users/studioaz/AZ\ Setter\ Cursor/studio-az-setter-backend
node test_fresh_start.js
```

This will:
1. Set the contact fields correctly
2. Create a new payment link
3. Show you the link to pay

After paying, you should see:
- ✅ Only 1 task created (not 6)
- ✅ Only 1 SMS sent (not 6)
- ✅ Correct task type: `artist_introduction` (not `pre_consultation_notes`)
- ✅ Correct badge: "Message Consult"

