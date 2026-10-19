import { InvitationAccept } from "@/components/members/invitation-accept";
import { getCurrentUser } from "@/server/auth/session";

export const metadata = { title: "Invitation · OneForAll" };

// Public page (see PUBLIC_PATHS): shows nothing about the invitation until the visitor is signed in; the details and
// the acceptance come from SECURITY DEFINER functions that check the token and the signed-in email.
export default async function InvitationPage() {
  const user = await getCurrentUser();
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="t-h1 text-fg">Join an organization</h1>
        <p className="t-body mt-1.5 text-fg-2">You were invited to a OneForAll workspace.</p>
      </div>
      <InvitationAccept signedIn={Boolean(user)} email={user?.email ?? null} />
    </div>
  );
}
