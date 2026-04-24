

















































import crypto from "crypto";
import { redis } from "../cache/client.js";
import { logger } from "../logger/index.js";

const COOKIE_NAME = "contactRevealAnonCount";
const MAX_FREE_REVEALS = 10;
const TTL_SECONDS = 30 * 24 * 60 * 60; 
const LOGIN_REDIRECT_PATH = "/login/signup";


const HIGH_COUNT_WARNING_THRESHOLD = 50;



const INCR_WITH_INITIAL_TTL_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return count
`;

let warnedMissingTrustProxy = false;

const anonFingerprint = (req) => {
	const trustProxy = req.app?.get?.("trust proxy");
	const xForwardedFor = req.headers?.["x-forwarded-for"];
	const trustProxyEnabled = Boolean(trustProxy);

	let ip = req.ip ?? "unknown-ip";
	if (!trustProxyEnabled && typeof xForwardedFor === "string" && xForwardedFor.trim()) {
		if (!warnedMissingTrustProxy) {
			warnedMissingTrustProxy = true;
			logger.warn(
				{ trustProxy, reqIp: req.ip, xForwardedFor },
				"contactRevealGate: X-Forwarded-For present but trust proxy disabled; using forwarded fallback IP",
			);
		}
		const forwardedIp = xForwardedFor.split(",")[0]?.trim();
		if (forwardedIp) ip = forwardedIp;
	}

	const ua = req.get("user-agent") ?? "unknown-ua";
	return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex");
};

const limitReachedResponse = (res) =>
	res.status(429).json({
		status: "error",
		message: "Free contact reveal limit reached. Please log in or sign up to continue.",
		code: "CONTACT_REVEAL_LIMIT_REACHED",
		loginRedirect: LOGIN_REDIRECT_PATH,
	});












const installPreResponseHook = (res, safeCookieCount, fingerprint, redisKey) => {
	let charged = false;

	
	
	
	
	
	
	
	
	
	
	
	
	const chargeQuota = (res) => {
		if (charged) return;
		charged = true;

		
		
		
		
		res.cookie(COOKIE_NAME, String(safeCookieCount + 1), {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			maxAge: TTL_SECONDS * 1000,
		});

		
		
		
		
		if (redis?.isOpen) {
			redis
				.eval(INCR_WITH_INITIAL_TTL_SCRIPT, {
					keys: [redisKey],
					arguments: [String(TTL_SECONDS)],
				})
				.then((newCount) => {
					if (newCount > HIGH_COUNT_WARNING_THRESHOLD) {
						logger.warn(
							{
								event: "guest_contact_reveal_high_count",
								fingerprintHash: fingerprint,
								count: newCount,
								threshold: HIGH_COUNT_WARNING_THRESHOLD,
							},
							`contactRevealGate: fingerprint count ${newCount} exceeds threshold — possible NAT collision or abuse`,
						);
					}
					logger.debug(
						{
							event: "guest_contact_reveal_charged",
							fingerprintHash: fingerprint,
							count: newCount,
						},
						"contactRevealGate: quota charged",
					);
					
					
					
				})
				.catch((redisErr) => {
					logger.warn(
						{ err: redisErr.message },
						"contactRevealGate: async Redis increment failed — cookie-only fallback used",
					);
				});
		}
	};

	
	
	
	const wrapMethod = (methodName) => {
		const original = res[methodName].bind(res);
		res[methodName] = (...args) => {
			const code = res.statusCode;
			if (code >= 200 && code < 300) {
				chargeQuota(res);
			}
			
			
			res.json = originalJson;
			res.send = originalSend;
			res.end = originalEnd;
			return original(...args);
		};
	};

	
	
	const originalJson = res.json.bind(res);
	const originalSend = res.send.bind(res);
	const originalEnd = res.end.bind(res);

	wrapMethod("json");
	wrapMethod("send");
	wrapMethod("end");
};

export const contactRevealGate = async (req, res, next) => {
	
	if (req.user?.isEmailVerified === true) {
		req.contactReveal = { emailOnly: false, verified: true };
		return next();
	}

	

	
	
	const cookieCount = Number.parseInt(req.cookies?.[COOKIE_NAME] ?? "0", 10);
	const safeCookieCount = Number.isFinite(cookieCount) ? cookieCount : 0;

	if (safeCookieCount >= MAX_FREE_REVEALS) {
		logger.debug({ fingerprint: "cookie-blocked" }, "contactRevealGate: guest blocked by cookie count");
		return limitReachedResponse(res);
	}

	
	
	
	
	
	const fingerprint = anonFingerprint(req);
	const redisKey = `contactRevealAnon:${fingerprint}`;

	if (redis?.isOpen) {
		try {
			const currentCount = await redis.get(redisKey);
			const parsedCount = currentCount !== null ? Number.parseInt(currentCount, 10) : 0;

			if (parsedCount >= MAX_FREE_REVEALS) {
				logger.debug(
					{ fingerprintHash: fingerprint, count: parsedCount },
					"contactRevealGate: guest blocked by Redis pre-check",
				);
				return limitReachedResponse(res);
			}
		} catch (redisErr) {
			
			logger.warn(
				{ err: redisErr.message },
				"contactRevealGate: Redis pre-check unavailable — falling back to cookie-only enforcement",
			);
		}
	}

	
	
	
	
	
	
	installPreResponseHook(res, safeCookieCount, fingerprint, redisKey);

	
	
	req.contactReveal = { emailOnly: true, verified: false };
	return next();
};
