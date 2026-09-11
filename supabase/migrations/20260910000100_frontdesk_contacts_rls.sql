-- Lock the contact index to the server.
--
-- The house convention is that server-only tables ship without RLS, but that
-- predates knowing the publishable key shipped inside the iOS binary can read
-- any table where RLS is off. This one holds every client's name, email and
-- phone for both locations — the most sensitive table in the project by
-- volume of personal data.
--
-- RLS on with NO policies: nothing reaches it through the anon/publishable
-- key. The backend uses the service role, which bypasses RLS, so the front
-- desk and iOS are unaffected.

alter table public.frontdesk_contacts enable row level security;
