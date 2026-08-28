// src/email/templates.js
//
// Pure functions that build { subject, html, text } for each email type.
// No provider knowledge lives here — these are handed to emailSender.send()
// as-is. Content is copied verbatim from the original email.service.js;
// only the provider branching was removed (each function used to build two
// near-duplicate HTML strings, one for brevo-api's more compact markup and
// one for the SMTP path's fuller template — the fuller template is kept
// here as the single source of truth for all providers, since the visual
// difference was never a deliberate provider-specific design decision).

export const buildOtpEmail = (otp) => ({
	subject: "Your Roomies verification code",
	text: `Your Roomies verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\nIf you did not request this code, you can safely ignore this email.`,
	html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Roomies verification code</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Verify your email address</p>
              <p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#52525b;">
                Use the code below to complete your verification. It expires in <strong>10 minutes</strong>.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="background-color:#f4f4f5; border-radius:10px; padding:28px 16px;">
                    <p style="margin:0 0 6px; font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#71717a;">Your verification code</p>
                    <p style="margin:0; font-size:40px; font-weight:700; letter-spacing:12px; color:#18181b; font-family:'Courier New', Courier, monospace;">${otp}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0; font-size:13px; line-height:1.6; color:#71717a;">
                Never share this code with anyone — Roomies will never ask for it.
                If you did not request this code, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
});

export const buildAdminLoginOtpEmail = (otp) => ({
	subject: "Your Roomies admin login code",
	text: `Your Roomies admin login code is: ${otp}\n\nSomeone is signing in to the Roomies admin panel with this account's password. This code expires in 10 minutes.\n\nIf you did not attempt to sign in, your password may be compromised — rotate it immediately. Never share this code with anyone.`,
	html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Roomies admin login code</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Admin sign-in verification</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Complete your admin sign-in</p>
              <p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#52525b;">
                Someone is signing in to the Roomies admin panel with this account's password.
                Enter the code below to finish signing in. It expires in <strong>10 minutes</strong>.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="background-color:#f4f4f5; border-radius:10px; padding:28px 16px;">
                    <p style="margin:0 0 6px; font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#71717a;">Your admin login code</p>
                    <p style="margin:0; font-size:40px; font-weight:700; letter-spacing:12px; color:#18181b; font-family:'Courier New', Courier, monospace;">${otp}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0; font-size:13px; line-height:1.6; color:#71717a;">
                If you did not attempt to sign in, your password may be compromised — rotate it immediately.
                Never share this code with anyone.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
});

export const buildVerificationApprovedEmail = (ownerName, businessName) => ({
	subject: "Your Roomies PG owner account has been verified",
	text:
		`Hi ${ownerName},\n\n` +
		`Great news! Your PG owner account on Roomies has been verified.\n\n` +
		`You can now create properties and post listings for students to discover.\n\n` +
		`Log in to get started: https://roomies.in/dashboard\n\n` +
		`If you have any questions, please contact our support team.\n\n` +
		`— The Roomies Team`,
	html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Account Verified — Roomies</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:22px;">✅</p>
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Account verified!</p>
              <p style="margin:0 0 20px; font-size:14px; line-height:1.6; color:#52525b;">
                Hi ${ownerName}, your PG owner account for <strong>${businessName ?? "your business"}</strong>
                has been reviewed and approved by our team.
              </p>
              <p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#52525b;">
                You can now create properties and post listings for students across India to discover.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center">
                    <a href="https://roomies.in/dashboard"
                       style="display:inline-block; background-color:#18181b; color:#ffffff; text-decoration:none;
                              padding:12px 28px; border-radius:8px; font-size:14px; font-weight:600;">
                      Go to Dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
});

export const buildVerificationRejectedEmail = (ownerName, rejectionReason) => {
	const reasonText = rejectionReason?.trim() || "Please review your submitted documents and try again.";
	return {
		subject: "Update on your Roomies verification request",
		text:
			`Hi ${ownerName},\n\n` +
			`We've reviewed your PG owner verification request and unfortunately we were unable to approve it at this time.\n\n` +
			`Reason: ${reasonText}\n\n` +
			`You can submit a new verification request with updated documents from your account settings.\n\n` +
			`If you have questions, please contact our support team.\n\n` +
			`— The Roomies Team`,
		html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verification Update — Roomies</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Verification update</p>
              <p style="margin:0 0 20px; font-size:14px; line-height:1.6; color:#52525b;">
                Hi ${ownerName}, we've reviewed your verification request but were unable to approve it
                with the documents currently on file.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
                <tr>
                  <td style="background-color:#fef2f2; border-left:3px solid #ef4444; border-radius:4px; padding:16px 20px;">
                    <p style="margin:0 0 4px; font-size:11px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#dc2626;">Reason</p>
                    <p style="margin:0; font-size:14px; color:#18181b; line-height:1.5;">${reasonText}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#52525b;">
                You can submit a new verification request with updated documents from your account settings.
                If you believe this decision was made in error, please contact our support team.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center">
                    <a href="https://roomies.in/settings/verification"
                       style="display:inline-block; background-color:#18181b; color:#ffffff; text-decoration:none;
                              padding:12px 28px; border-radius:8px; font-size:14px; font-weight:600;">
                      Resubmit Documents
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
	};
};

export const buildVerificationPendingEmail = (ownerName, businessName) => {
	const displayBusiness = businessName ?? "your business";
	return {
		subject: "We received your Roomies verification documents",
		text:
			`Hi ${ownerName},\n\n` +
			`Thank you for submitting verification documents for ${displayBusiness} on Roomies.\n\n` +
			`Our team has received your submission and will review it within 2–3 business days. ` +
			`We will email you as soon as a decision has been made.\n\n` +
			`If you have any questions in the meantime, please contact our support team.\n\n` +
			`— The Roomies Team`,
		html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Documents Received — Roomies</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5; padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px; background-color:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden;">
          <tr>
            <td style="background-color:#18181b; padding:28px 40px 24px;">
              <p style="margin:0; font-size:22px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">Roomies</p>
              <p style="margin:6px 0 0; font-size:13px; color:#a1a1aa;">Find your perfect PG or roommate</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 32px;">
              <p style="margin:0 0 8px; font-size:22px;">📋</p>
              <p style="margin:0 0 8px; font-size:16px; font-weight:600; color:#18181b;">Documents received</p>
              <p style="margin:0 0 20px; font-size:14px; line-height:1.6; color:#52525b;">
                Hi ${ownerName}, we've received the verification documents for
                <strong>${displayBusiness}</strong>.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
                <tr>
                  <td style="background-color:#fefce8; border-left:3px solid #eab308; border-radius:4px; padding:16px 20px;">
                    <p style="margin:0 0 4px; font-size:11px; font-weight:600; letter-spacing:1px; text-transform:uppercase; color:#a16207;">Status</p>
                    <p style="margin:0; font-size:14px; color:#18181b; font-weight:600;">Under review</p>
                    <p style="margin:4px 0 0; font-size:13px; color:#71717a; line-height:1.5;">
                      Our team will review your submission within 2–3 business days.
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px; font-size:14px; line-height:1.6; color:#52525b;">
                You will receive another email as soon as a decision has been made.
                No further action is required from you at this time.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#fafafa; border-top:1px solid #f0f0f0; padding:20px 40px;">
              <p style="margin:0; font-size:12px; color:#a1a1aa; line-height:1.5;">
                This is an automated message from Roomies. Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
	};
};
