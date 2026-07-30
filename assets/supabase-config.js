// Public site only. The anon key is meant to be published; Row Level Security
// in app/schema.sql is what protects the data. The audit form can INSERT into
// intake_submissions and read nothing back.
//
// Project: monsoons-ai (us-west-1). If this key ever needs rotating it is at
// Supabase → Project Settings → API keys. Rotating changes nothing about what a
// holder can do: the permissions live in the RLS policies, not in the key.
export const SUPABASE = {
  url: 'https://uvqvqtgrdfzesmrjnoae.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2cXZxdGdyZGZ6ZXNtcmpub2FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNzc1MjksImV4cCI6MjEwMDk1MzUyOX0.RJvlStor_XWgT9RgZIjXgcW56ZfZOPjLL1vy6tiF2-M',
};
