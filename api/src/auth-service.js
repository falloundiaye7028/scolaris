import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE,
  SESSION_IDLE_SECONDS,
  SESSION_LIMIT_PER_USER,
  clearSessionCookie,
  clientAddress,
  isOpaqueSessionToken,
  newOpaqueToken,
  opaqueDigest,
  parseCookies,
  sessionCookie,
} from "./security.js";
import {
  createRecoveryCodes,
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpSecret,
  hashPassword,
  rehashVerifiedPassword,
  recoveryCodeDigest,
  verifyPassword,
  verifyTotp,
} from "./auth-security.js";

export const MFA_CHALLENGE_COOKIE = "scolaris_mfa_challenge";
const RECENT_AUTH_SECONDS = 10 * 60;

function challengeCookie(token, { secure = true } = {}) {
  return [
    `${MFA_CHALLENGE_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/api/auth/mfa",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Max-Age=300",
  ].filter(Boolean).join("; ");
}

function clearChallengeCookie({ secure = true } = {}) {
  return [
    `${MFA_CHALLENGE_COOKIE}=`,
    "Path=/api/auth/mfa",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; ");
}

export function createAuthService({ pool, secret, production, mfaEncryptionKey = "", mfaIssuer = "SCOLARIS PAY", passwordResetWebhookUrl = "", passwordResetWebhookSecret = "", resendApiKey = "", resendFromEmail = "SCOLARIS PAY <noreply@mail.scolarispay.online>", passwordResetBaseUrl = "https://www.scolarispay.online" }) {
  const deviceHashes = (req) => ({
    ipHash: opaqueDigest(clientAddress(req), secret),
    userAgentHash: opaqueDigest(String(req.headers["user-agent"] || "").slice(0, 512), secret),
  });

  const securityEvent = async (req, { type, severity = "info", outcome, userId = null, schoolId = null, metadata = {} }) => {
    const { ipHash, userAgentHash } = deviceHashes(req);
    await pool.query(
      "INSERT INTO security_events(school_id,user_id,event_type,severity,outcome,ip_hash,user_agent_hash,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [schoolId, userId, type, severity, outcome, ipHash, userAgentHash, JSON.stringify(metadata)],
    );
  };

  const issueSession = async (req, res, user, { authMethod = "password" } = {}) => {
    const token = newOpaqueToken();
    const tokenHash = opaqueDigest(token, secret);
    const sessionId = crypto.randomUUID();
    const idleExpires = new Date(Date.now() + SESSION_IDLE_SECONDS * 1000);
    const absoluteExpires = new Date(Date.now() + SESSION_ABSOLUTE_SECONDS * 1000);
    const { ipHash, userAgentHash } = deviceHashes(req);
    await pool.query("DELETE FROM sessions WHERE absolute_expires_at<=now() OR expires_at<=now() OR revoked_at IS NOT NULL");
    await pool.query(
      "INSERT INTO sessions(id,user_id,school_id,token_hash,expires_at,absolute_expires_at,reauthenticated_at,auth_method,ip_hash,user_agent_hash) VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8,$9)",
      [sessionId, user.id, user.school_id, tokenHash, idleExpires, absoluteExpires, authMethod, ipHash, userAgentHash],
    );
    await pool.query(
      `UPDATE sessions SET revoked_at=now()
       WHERE user_id=$1 AND revoked_at IS NULL AND id NOT IN (
         SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() AND absolute_expires_at>now()
         ORDER BY created_at DESC LIMIT $2
       )`,
      [user.id, SESSION_LIMIT_PER_USER],
    );
    res.setHeader("set-cookie", sessionCookie(token, { secure: production }));
    return sessionId;
  };

  const fromOpaqueToken = async (token) => {
    const tokenHash = opaqueDigest(token, secret);
    return (await pool.query(
      `SELECT u.id,u.school_id,u.name,u.email,u.role,u.is_platform_admin,u.is_active,
              EXISTS(SELECT 1 FROM user_mfa m WHERE m.user_id=u.id AND m.enabled_at IS NOT NULL) mfa_enabled,
              s.id session_id,s.expires_at,s.absolute_expires_at,s.reauthenticated_at,s.ip_hash,s.user_agent_hash
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.absolute_expires_at>now()`,
      [tokenHash],
    )).rows[0];
  };

  const fromLegacyJwt = async (token) => {
    let claims;
    try {
      claims = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "scolaris-pay", audience: "scolaris-app" });
    } catch {
      return null;
    }
    if (!claims.sid || !claims.sub || !claims.schoolId) return null;
    return (await pool.query(
      `SELECT u.id,u.school_id,u.name,u.email,u.role,u.is_platform_admin,u.is_active,
              EXISTS(SELECT 1 FROM user_mfa m WHERE m.user_id=u.id AND m.enabled_at IS NOT NULL) mfa_enabled,
              s.id session_id,s.expires_at,COALESCE(s.absolute_expires_at,s.expires_at) absolute_expires_at,
              s.reauthenticated_at,s.ip_hash,s.user_agent_hash
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.school_id=$3 AND s.token_hash IS NULL
         AND s.revoked_at IS NULL AND s.expires_at>now() AND COALESCE(s.absolute_expires_at,s.expires_at)>now()`,
      [claims.sid, claims.sub, claims.schoolId],
    )).rows[0];
  };

  const authenticate = async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) throw new Error("unauthorized");
    let row = isOpaqueSessionToken(token) ? await fromOpaqueToken(token) : await fromLegacyJwt(token);
    if (!row || !row.is_active) {
      if (row && !row.is_active) await pool.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [row.id]);
      throw new Error("unauthorized");
    }
    const { ipHash, userAgentHash } = deviceHashes(req);
    if (row.user_agent_hash && row.user_agent_hash !== userAgentHash) {
      await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [row.session_id]);
      await securityEvent(req, { type: "session.device_mismatch", severity: "warning", outcome: "denied", userId: row.id, schoolId: row.school_id });
      throw new Error("unauthorized");
    }
    if (!isOpaqueSessionToken(token)) {
      const rotatedToken = newOpaqueToken();
      const result = await pool.query(
        "UPDATE sessions SET token_hash=$1,expires_at=LEAST(absolute_expires_at,now()+interval '30 minutes'),last_seen_at=now(),ip_hash=$2,user_agent_hash=$3 WHERE id=$4 AND token_hash IS NULL",
        [opaqueDigest(rotatedToken, secret), ipHash, userAgentHash, row.session_id],
      );
      if (!result.rowCount) throw new Error("unauthorized");
      res.setHeader("set-cookie", sessionCookie(rotatedToken, { secure: production }));
    } else {
      await pool.query(
        "UPDATE sessions SET expires_at=LEAST(absolute_expires_at,now()+interval '30 minutes'),last_seen_at=now(),ip_hash=$1 WHERE id=$2",
        [ipHash, row.session_id],
      );
    }
    return {
      sub: row.id,
      schoolId: row.school_id,
      role: row.role,
      name: row.name,
      email: row.email,
      sid: row.session_id,
      platformAdmin: row.is_platform_admin,
      mfaEnabled: Boolean(row.mfa_enabled),
      reauthenticatedAt: row.reauthenticated_at,
    };
  };

  const requireRecentAuthentication = (me) => {
    if (!me?.reauthenticatedAt || Date.now() - new Date(me.reauthenticatedAt).getTime() > RECENT_AUTH_SECONDS * 1000) {
      throw new Error("reauthentication_required");
    }
  };

  const reauthenticate = async (req, me, password) => {
    const user = (await pool.query("SELECT id,password_hash,is_active FROM users WHERE id=$1 AND school_id=$2", [me.sub, me.schoolId])).rows[0];
    const verification = await verifyPassword(user?.password_hash, password);
    if (!user?.is_active || !verification.valid) {
      await securityEvent(req, { type: "reauthentication.failed", severity: "warning", outcome: "denied", userId: me.sub, schoolId: me.schoolId });
      return false;
    }
    await pool.query("UPDATE sessions SET reauthenticated_at=now() WHERE id=$1 AND user_id=$2", [me.sid, me.sub]);
    await securityEvent(req, { type: "reauthentication.succeeded", outcome: "success", userId: me.sub, schoolId: me.schoolId });
    return true;
  };

  const changePassword = async (req, res, me, currentPassword, newPassword) => {
    requireRecentAuthentication(me);
    const user = (await pool.query("SELECT id,school_id,password_hash,is_active FROM users WHERE id=$1 AND school_id=$2", [me.sub, me.schoolId])).rows[0];
    const verification = await verifyPassword(user?.password_hash, currentPassword);
    if (!user?.is_active || !verification.valid) throw new Error("invalid_credentials");
    const passwordHash = await hashPassword(newPassword);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE users SET password_hash=$1,password_changed_at=now() WHERE id=$2", [passwordHash, me.sub]);
      await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [me.sub]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await issueSession(req, res, user, { authMethod: "password_change" });
    await securityEvent(req, { type: "password.changed", severity: "warning", outcome: "success", userId: me.sub, schoolId: me.schoolId });
  };

  const createMfaChallenge = async (req, res, user) => {
    const token = newOpaqueToken();
    await pool.query(
      "INSERT INTO mfa_challenges(user_id,challenge_hash,expires_at) VALUES($1,$2,now()+interval '5 minutes')",
      [user.id, opaqueDigest(token, secret)],
    );
    res.setHeader("set-cookie", challengeCookie(token, { secure: production }));
  };

  const completeMfaChallenge = async (req, res, code) => {
    if (!mfaEncryptionKey) throw new Error("mfa_unavailable");
    const challengeToken = parseCookies(req.headers.cookie)[MFA_CHALLENGE_COOKIE];
    if (!challengeToken || !isOpaqueSessionToken(challengeToken)) throw new Error("invalid_mfa");
    const challenge = (await pool.query(
      `SELECT c.id challenge_id,c.user_id,u.id,c.attempts,u.school_id,u.name,u.email,u.role,u.is_platform_admin,u.is_active,m.secret_ciphertext
       FROM mfa_challenges c JOIN users u ON u.id=c.user_id JOIN user_mfa m ON m.user_id=u.id
       WHERE c.challenge_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() AND m.enabled_at IS NOT NULL`,
      [opaqueDigest(challengeToken, secret)],
    )).rows[0];
    if (!challenge || !challenge.is_active || challenge.attempts >= 5) throw new Error("invalid_mfa");
    const totpValid = verifyTotp(decryptMfaSecret(challenge.secret_ciphertext, mfaEncryptionKey), code);
    let recoveryValid = false;
    let recoveryId;
    if (!totpValid) {
      const recoveryHash = recoveryCodeDigest(code, secret);
      const recovery = (await pool.query("SELECT id FROM mfa_recovery_codes WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL", [challenge.user_id, recoveryHash])).rows[0];
      recoveryValid = Boolean(recovery);
      recoveryId = recovery?.id;
    }
    if (!totpValid && !recoveryValid) {
      await pool.query("UPDATE mfa_challenges SET attempts=attempts+1 WHERE id=$1", [challenge.challenge_id]);
      await securityEvent(req, { type: "mfa.failed", severity: "warning", outcome: "denied", userId: challenge.user_id, schoolId: challenge.school_id });
      throw new Error("invalid_mfa");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query("UPDATE mfa_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id", [challenge.challenge_id]);
      if (!consumed.rowCount) throw new Error("invalid_mfa");
      if (recoveryId) {
        const recovered = await client.query("UPDATE mfa_recovery_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id", [recoveryId]);
        if (!recovered.rowCount) throw new Error("invalid_mfa");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await issueSession(req, res, challenge, { authMethod: recoveryValid ? "mfa_recovery" : "mfa_totp" });
    res.setHeader("set-cookie", [res.getHeader("set-cookie"), clearChallengeCookie({ secure: production })]);
    await securityEvent(req, { type: "mfa.succeeded", outcome: "success", userId: challenge.user_id, schoolId: challenge.school_id, metadata: { recoveryCode: recoveryValid } });
    return challenge;
  };

  const beginMfaSetup = async (req, me) => {
    requireRecentAuthentication(me);
    if (!mfaEncryptionKey) throw new Error("mfa_unavailable");
    const secretValue = generateTotpSecret();
    await pool.query(
      `INSERT INTO user_mfa(user_id,secret_ciphertext,enabled_at,verified_at,updated_at)
       VALUES($1,$2,NULL,NULL,now())
       ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,enabled_at=NULL,verified_at=NULL,updated_at=now()`,
      [me.sub, encryptMfaSecret(secretValue, mfaEncryptionKey)],
    );
    await pool.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [me.sub]);
    await securityEvent(req, { type: "mfa.setup_started", outcome: "success", userId: me.sub, schoolId: me.schoolId });
    const label = encodeURIComponent(`${mfaIssuer}:${me.email}`);
    return { provisioningUri: `otpauth://totp/${label}?secret=${secretValue}&issuer=${encodeURIComponent(mfaIssuer)}&algorithm=SHA1&digits=6&period=30` };
  };

  const confirmMfaSetup = async (req, me, code) => {
    requireRecentAuthentication(me);
    if (!mfaEncryptionKey) throw new Error("mfa_unavailable");
    const record = (await pool.query("SELECT secret_ciphertext FROM user_mfa WHERE user_id=$1 AND enabled_at IS NULL", [me.sub])).rows[0];
    if (!record || !verifyTotp(decryptMfaSecret(record.secret_ciphertext, mfaEncryptionKey), code)) {
      await securityEvent(req, { type: "mfa.setup_failed", severity: "warning", outcome: "denied", userId: me.sub, schoolId: me.schoolId });
      throw new Error("invalid_mfa");
    }
    const codes = createRecoveryCodes();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE user_mfa SET enabled_at=now(),verified_at=now(),updated_at=now() WHERE user_id=$1", [me.sub]);
      await client.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [me.sub]);
      for (const recoveryCode of codes) {
        await client.query("INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)", [me.sub, recoveryCodeDigest(recoveryCode, secret)]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await securityEvent(req, { type: "mfa.enabled", severity: "warning", outcome: "success", userId: me.sub, schoolId: me.schoolId });
    return codes;
  };

  const disableMfa = async (req, me, password) => {
    requireRecentAuthentication(me);
    const user = (await pool.query("SELECT password_hash,is_active FROM users WHERE id=$1 AND school_id=$2", [me.sub, me.schoolId])).rows[0];
    const verification = await verifyPassword(user?.password_hash, password);
    if (!user?.is_active || !verification.valid) throw new Error("invalid_credentials");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM user_mfa WHERE user_id=$1", [me.sub]);
      await client.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [me.sub]);
      await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL", [me.sub, me.sid]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await securityEvent(req, { type: "mfa.disabled", severity: "critical", outcome: "success", userId: me.sub, schoolId: me.schoolId });
  };

  const listSessions = async (me) => (await pool.query(
    `SELECT id,created_at,last_seen_at,expires_at,absolute_expires_at,auth_method,(id=$2) current
     FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() AND absolute_expires_at>now()
     ORDER BY last_seen_at DESC LIMIT $3`,
    [me.sub, me.sid, SESSION_LIMIT_PER_USER],
  )).rows;

  const revokeSession = async (req, me, sessionId) => {
    const result = await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", [sessionId, me.sub]);
    if (result.rowCount) await securityEvent(req, { type: "session.revoked", severity: "warning", outcome: "success", userId: me.sub, schoolId: me.schoolId, metadata: { current: sessionId === me.sid } });
    return result.rowCount > 0;
  };

  const requestPasswordReset = async (req, email) => {
    const user = (await pool.query("SELECT id,school_id,email FROM users WHERE email=$1 AND is_active=true", [email])).rows[0];
    const { ipHash } = deviceHashes(req);
    const recentRequests = Number((await pool.query(
      `SELECT count(*)::int total FROM security_events
       WHERE created_at>now()-interval '1 hour' AND event_type IN ('password_reset.requested','password_reset.delivery_failed')
         AND (ip_hash=$1 OR ($2::uuid IS NOT NULL AND user_id=$2))`,
      [ipHash, user?.id || null],
    )).rows[0].total);
    if (recentRequests >= 5) return;
    const deliveryConfigured = Boolean(passwordResetWebhookUrl || resendApiKey);
    if (!user || !deliveryConfigured) {
      await securityEvent(req, { type: "password_reset.requested", outcome: "accepted", userId: user?.id || null, schoolId: user?.school_id || null, metadata: { deliveryConfigured } });
      return;
    }
    const endpoint = passwordResetWebhookUrl ? new URL(passwordResetWebhookUrl) : null;
    if (endpoint && endpoint.protocol !== "https:") throw new Error("password_reset_unavailable");
    const token = newOpaqueToken();
    const result = await pool.query(
      "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,requested_ip_hash) VALUES($1,$2,now()+interval '30 minutes',$3) RETURNING id",
      [user.id, opaqueDigest(token, secret), deviceHashes(req).ipHash],
    );
    try {
      let response;
      if (endpoint) {
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          headers: {
            "content-type": "application/json",
            ...(passwordResetWebhookSecret ? { authorization: `Bearer ${passwordResetWebhookSecret}` } : {}),
          },
          body: JSON.stringify({ email: user.email, token, expiresInMinutes: 30 }),
        });
      } else {
        const resetUrl = new URL("/reinitialiser-mot-de-passe", passwordResetBaseUrl);
        resetUrl.hash = new URLSearchParams({ token }).toString();
        const link = resetUrl.toString();
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          headers: {
            authorization: `Bearer ${resendApiKey}`,
            "content-type": "application/json",
            "Idempotency-Key": `password-reset-${result.rows[0].id}`,
          },
          body: JSON.stringify({
            from: resendFromEmail,
            to: [user.email],
            subject: "Réinitialisez votre mot de passe SCOLARIS PAY",
            text: `Bonjour,\n\nUtilisez ce lien valable 30 minutes pour définir un nouveau mot de passe SCOLARIS PAY :\n${link}\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.\n\nL’équipe SCOLARIS PAY`,
            html: `<p>Bonjour,</p><p>Utilisez le bouton ci-dessous dans les 30 minutes pour définir un nouveau mot de passe SCOLARIS PAY.</p><p><a href="${link}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#22a879;color:#fff;text-decoration:none;font-weight:700">Définir un nouveau mot de passe</a></p><p>Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.</p><p>L’équipe SCOLARIS PAY</p>`,
          }),
        });
      }
      if (!response.ok) throw new Error("delivery_failed");
      await securityEvent(req, { type: "password_reset.requested", outcome: "delivered", userId: user.id, schoolId: user.school_id });
    } catch {
      await pool.query("DELETE FROM password_reset_tokens WHERE id=$1", [result.rows[0].id]);
      await securityEvent(req, { type: "password_reset.delivery_failed", severity: "critical", outcome: "failed", userId: user.id, schoolId: user.school_id });
    }
  };

  const resetPassword = async (req, res, token, newPassword) => {
    if (!isOpaqueSessionToken(token)) throw new Error("invalid_reset_token");
    const client = await pool.connect();
    let user;
    try {
      await client.query("BEGIN");
      user = (await client.query(
        `SELECT u.id,u.school_id,u.is_active,t.id token_id
         FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
         WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>now() FOR UPDATE`,
        [opaqueDigest(token, secret)],
      )).rows[0];
      if (!user?.is_active) throw new Error("invalid_reset_token");
      const passwordHash = await hashPassword(newPassword);
      await client.query("UPDATE users SET password_hash=$1,password_changed_at=now() WHERE id=$2", [passwordHash, user.id]);
      await client.query("UPDATE password_reset_tokens SET consumed_at=now() WHERE id=$1", [user.token_id]);
      await client.query("UPDATE password_reset_tokens SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=$1", [user.id]);
      await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [user.id]);
      await client.query("UPDATE mfa_challenges SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=$1", [user.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.setHeader("set-cookie", clearSessionCookie({ secure: production }));
    await securityEvent(req, { type: "password_reset.completed", severity: "warning", outcome: "success", userId: user.id, schoolId: user.school_id });
  };

  return {
    authenticate,
    beginMfaSetup,
    changePassword,
    clearChallengeCookie: () => clearChallengeCookie({ secure: production }),
    completeMfaChallenge,
    confirmMfaSetup,
    createMfaChallenge,
    disableMfa,
    issueSession,
    listSessions,
    requestPasswordReset,
    reauthenticate,
    requireRecentAuthentication,
    revokeSession,
    resetPassword,
    securityEvent,
    verifyPassword,
    hashPassword,
    rehashVerifiedPassword,
  };
}
