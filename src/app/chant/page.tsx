import { redirect } from "next/navigation";

// /chant is where the app lived while the front door was a landing page.
//
// Kept as a redirect rather than deleted, because the link has already been
// shared: a URL someone sent to a fellow devotee should not begin returning
// 404 because the site was rearranged around them.

export default function ChantPage() {
  redirect("/");
}
