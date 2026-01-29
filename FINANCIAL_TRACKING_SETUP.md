# Financial Tracking Setup Guide

This guide explains how to set up and use the financial tracking features in the studio-az-setter-backend.

## Environment Variables

Add these environment variables to your `.env` file (or Render environment settings):

```bash
# Supabase Configuration (Required for Financial Tracking)
SUPABASE_URL=https://rwqjkqggrlpkitoxbugg.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3cWprcWdncmxwa2l0b3hidWdnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODg4ODc0NCwiZXhwIjoyMDg0NDYwNzQ0fQ.Izws_X-Wtp7YiXhMw9eQaTn4Ib5wzrmX-4By8tpsFvs

# GHL Configuration (Required for updating contact custom fields)
GHL_API_KEY=your_ghl_api_key_here
GHL_LOCATION_ID=your_ghl_location_id_here
```

## Installation

The required dependencies are already added to `package.json`. Run:

```bash
npm install
```

This will install `@supabase/supabase-js` along with other dependencies.

## Features

### Automatic Financial Tracking

The system automatically tracks financial transactions when:

1. **Square Payments**: When a deposit is paid via Square, the payment is automatically recorded in the `transactions` table
2. **Client Lifetime Value**: Each transaction updates the `client_financials` table with:
   - Total spent
   - Total deposits
   - Total session payments
   - Total tips
   - Number of completed tattoos
   - First/last appointment dates
   - Returning client status

3. **Artist Commissions**: Each transaction calculates:
   - Shop percentage/amount
   - Artist percentage/amount
   - Settlement status (pending/settled)

### Manual Transaction Recording

For cash, Venmo, Zelle, or other payments not processed through Square:

**Endpoint**: `POST /api/transactions`

**Request Body**:
```json
{
  "contactId": "ghl_contact_id",
  "contactName": "John Doe",
  "appointmentId": "optional_appointment_id",
  "artistId": "artist_ghl_id",
  "transactionType": "session_payment",
  "paymentMethod": "cash",
  "paymentRecipient": "shop",
  "grossAmount": 250.00,
  "sessionDate": "2026-01-29T10:00:00Z",
  "notes": "Touch-up session payment",
  "locationId": "studio_az_tattoo"
}
```

**Transaction Types**:
- `deposit`: $50 deposit payment
- `session_payment`: Full tattoo session payment
- `tip`: Tips for artists

**Payment Methods**:
- `square`: Square payment (automatically recorded)
- `cash`: Cash payment
- `venmo`: Venmo payment
- `zelle`: Zelle payment
- `other`: Other payment methods

**Payment Recipient**:
- `shop`: Payment received by shop (most common)
- `artist_direct`: Payment received directly by artist

### Artist Earnings Report

Get earnings summary for an artist:

**Endpoint**: `GET /api/artists/:artistId/earnings`

**Query Parameters** (optional):
- `locationId`: Filter by location
- `startDate`: Filter transactions after this date (ISO format)
- `endDate`: Filter transactions before this date (ISO format)

**Example**:
```
GET /api/artists/abc123/earnings?startDate=2026-01-01&endDate=2026-01-31
```

**Response**:
```json
{
  "success": true,
  "earnings": {
    "artistId": "abc123",
    "totalEarned": 1250.00,
    "pendingFromShop": 300.00,
    "owedToShop": 0.00,
    "netBalance": 300.00,
    "transactionCount": 8,
    "transactions": [...]
  }
}
```

### Client Lifetime Value

Get financial summary for a client:

**Endpoint**: `GET /api/contacts/:contactId/financials`

**Example**:
```
GET /api/contacts/xyz789/financials
```

**Response**:
```json
{
  "success": true,
  "financials": {
    "contact_id": "xyz789",
    "contact_name": "Jane Smith",
    "total_spent": 850.00,
    "total_deposits": 100.00,
    "total_sessions": 750.00,
    "total_tips": 0.00,
    "total_appointments": 3,
    "completed_tattoos": 2,
    "first_appointment_date": "2025-06-15T10:00:00Z",
    "last_appointment_date": "2026-01-20T14:00:00Z",
    "last_payment_date": "2026-01-20T16:30:00Z",
    "is_returning_client": true
  }
}
```

## Database Tables

### transactions
Stores all financial transactions with:
- Contact and artist information
- Transaction type, method, and recipient
- Gross amount and commission splits
- Settlement status
- Square payment ID (for automated tracking)

### client_financials
Aggregated client lifetime value data:
- Total spending across all categories
- Number of completed tattoos
- Date tracking
- Returning client status

### artist_commission_rates
Commission rate structure for artists:
- Shop percentage
- Artist percentage
- Effective date ranges
- Location-specific rates

## GHL Custom Fields

The system automatically updates these GHL custom fields (if GHL_API_KEY is configured):

- `client_lifetime_value`: Total amount spent
- `total_tattoos_completed`: Number of completed tattoos
- `last_payment_date`: Most recent payment date

## Usage in iOS App

The iOS app can use these endpoints to:

1. **Record manual payments** when artists receive cash/Venmo/Zelle
2. **View artist earnings** to show pending payouts
3. **Display client LTV** to identify high-value clients
4. **Track commission splits** for settlement purposes

## Testing

After deployment, test with a Square sandbox payment:

1. Trigger a $50 deposit payment through Square
2. Check Supabase `transactions` table for the new record
3. Check `client_financials` table for updated LTV
4. Verify GHL custom fields are updated (if configured)

## Troubleshooting

If financial tracking isn't working:

1. Check that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set
2. Verify the Supabase tables exist (see database migration files)
3. Check server logs for `[Financial]` messages
4. Ensure Square webhook is configured and sending payment events
5. Verify that artist IDs match between GHL and the database

## Commission Rate Configuration

To set custom commission rates for artists:

1. Add records to the `artist_commission_rates` table
2. Set `artist_ghl_id` to the GHL user/contact ID
3. Set `shop_percentage` and `artist_percentage` (must sum to 100)
4. Set `effective_from` date
5. Leave `effective_to` as `NULL` for current rates

Default rate is 50/50 if no custom rate is found.

