// Public site only. The anon key is meant to be published; Row Level Security
// in app/schema.sql is what protects the data. The audit form can INSERT into
// intake_submissions and read nothing back.
export const SUPABASE = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-ANON-KEY',
};
