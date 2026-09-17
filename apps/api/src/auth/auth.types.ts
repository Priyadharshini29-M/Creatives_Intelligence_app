export interface AuthenticatedUser {
  id: string;
  supabaseId: string;
  email: string;
  /** The user's active team (personal team until team switching ships). */
  teamId: string;
  role: string;
}
