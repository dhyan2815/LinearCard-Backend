import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class OtpService {
  constructor(private readonly supabaseService: SupabaseService) {}

  hashOtp(otp: string): string {
    return createHash('sha256').update(otp).digest('hex');
  }

  verifyOtp(plainOtp: string, hashedOtp: string): boolean {
    const plainHash = Buffer.from(this.hashOtp(plainOtp));
    const stored = Buffer.from(hashedOtp);
    if (plainHash.length !== stored.length) return false;
    return timingSafeEqual(plainHash, stored);
  }

  /** Wrong guesses allowed before an OTP session is burned (SEC-4). */
  static readonly MAX_VERIFY_ATTEMPTS = 5;

  /**
   * Verifies an OTP against a session row and counts failures. Sending was
   * rate-limited but verifying was not — 4 digits with unlimited guesses is
   * brute-forceable in seconds. On the 5th wrong guess the session is
   * consumed, so the caller must request a fresh code.
   */
  async verifyOtpAttempt(
    plainOtp: string,
    session: { id: string; otpHash: string; attempts?: number | null },
  ): Promise<{ ok: boolean; locked: boolean }> {
    const attempts = session.attempts ?? 0;
    if (attempts >= OtpService.MAX_VERIFY_ATTEMPTS) {
      return { ok: false, locked: true };
    }

    if (this.verifyOtp(plainOtp, session.otpHash)) {
      return { ok: true, locked: false };
    }

    const next = attempts + 1;
    const locked = next >= OtpService.MAX_VERIFY_ATTEMPTS;
    await this.supabaseService.client
      .from('OtpSession')
      .update({
        attempts: next,
        // Burning the session is what actually stops the brute force; the
        // counter alone would reset on the next lookup.
        ...(locked ? { consumedAt: new Date().toISOString() } : {}),
      })
      .eq('id', session.id);

    return { ok: false, locked };
  }

  async isOtpRateLimited(phone: string, purpose: string): Promise<boolean> {
    const { data } = await this.supabaseService.client
      .from('OtpSession')
      .select('createdAt')
      .eq('phone', phone)
      .eq('purpose', purpose)
      .is('consumedAt', null)
      .order('createdAt', { ascending: false })
      .limit(3);

    if (!data || data.length < 3) {
      return false;
    }

    const newest = new Date(data[0].createdAt).getTime();
    const oldest = new Date(data[2].createdAt).getTime();
    const now = Date.now();
    const fiveMins = 5 * 60 * 1000;

    // Check if 3 unconsumed requests were made within a 5-minute window
    const isBurst = newest - oldest < fiveMins;

    // If they hit the burst limit, block until 5 minutes have passed since the newest request
    if (isBurst && now - newest < fiveMins) {
      return true;
    }

    return false;
  }
}
