<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\Account;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class WeretradeSsoService
{
    /**
     * Verify an HMAC-SHA256 JWT from login.weretrade.com using the shared secret.
     */
    public function verifyJwt(string $jwt): ?array
    {
        $secret = config('trypost.weretrade_sso.jwt_secret');
        if (empty($secret)) {
            return null;
        }

        $parts = explode('.', trim($jwt));
        if (count($parts) !== 3) {
            return null;
        }

        [$headerB64, $payloadB64, $sigB64] = $parts;

        $expectedSig = hash_hmac('sha256', "{$headerB64}.{$payloadB64}", $secret, true);
        $expectedSigB64 = rtrim(strtr(base64_encode($expectedSig), '+/', '-_'), '=');

        if (! hash_equals($expectedSigB64, $sigB64)) {
            Log::warning('weretrade SSO: Token signature verification failed');
            return null;
        }

        $payloadJson = base64_decode(strtr($payloadB64, '-_', '+/'));
        $payload = json_decode($payloadJson, true);

        if (! is_array($payload)) {
            return null;
        }

        if (isset($payload['exp']) && time() >= $payload['exp']) {
            return null;
        }

        return $payload;
    }

    /**
     * Attempt transparent SSO authentication from an incoming request.
     */
    public function attemptAutoLogin(Request $request): ?User
    {
        if (! config('trypost.weretrade_sso_enabled', true)) {
            return null;
        }

        // 1. Check Cloudflare Access identity header
        $cfEmail = $request->header('cf-access-authenticated-user-email')
            ?? $request->header('Cf-Access-Authenticated-User-Email');

        if ($cfEmail && filter_var($cfEmail, FILTER_VALIDATE_EMAIL)) {
            return $this->findOrCreateUser($cfEmail, explode('@', $cfEmail)[0]);
        }

        // 2. Check weretrade session cookie or Bearer JWT or query param
        $token = $request->query('token')
            ?? $request->query('session')
            ?? $request->cookie('session')
            ?? $request->bearerToken()
            ?? $request->header('x-session-token');

        if ($token) {
            $payload = $this->verifyJwt($token);
            if ($payload) {
                $email = $payload['username'] ?? $payload['email'] ?? null;
                if ($email && filter_var($email, FILTER_VALIDATE_EMAIL)) {
                    $name = $payload['name'] ?? $payload['display_name'] ?? explode('@', $email)[0];
                    return $this->findOrCreateUser($email, $name);
                }
                Log::warning('weretrade SSO: Token valid but email invalid/missing in payload', ['payload' => $payload]);
            } else {
                Log::warning('weretrade SSO: Token signature verification failed');
            }
        }

        return null;
    }

    /**
     * Find an existing user or auto-provision a new user attached to weretrade workspaces.
     */
    public function findOrCreateUser(string $email, ?string $name = null): User
    {
        $email = strtolower(trim($email));
        $user = User::where('email', $email)->first();

        if ($user) {
            if (! $user->hasVerifiedEmail()) {
                $user->markEmailAsVerified();
            }
            $this->ensureWorkspaceAccess($user);
            return $user;
        }

        $displayName = $name ?: explode('@', $email)[0];

        $primaryAccount = Account::first();

        $user = User::create([
            'name' => $displayName,
            'email' => $email,
            'password' => Hash::make(Str::random(32)),
            'email_verified_at' => now(),
            'current_role' => 'admin',
            'account_id' => $primaryAccount?->id,
        ]);

        if (! $primaryAccount) {
            $account = Account::create([
                'user_id' => $user->id,
                'name' => "weretrade Team",
            ]);
            $user->forceFill(['account_id' => $account->id])->saveQuietly();
        }

        $this->ensureWorkspaceAccess($user);

        Log::info("weretrade SSO: Auto-provisioned user {$email} ({$user->id})");

        return $user;
    }

    /**
     * Ensure the user has membership in existing weretrade workspaces.
     */
    public function ensureWorkspaceAccess(User $user): void
    {
        $primaryAccount = Account::first();
        if ($primaryAccount && $user->account_id !== $primaryAccount->id) {
            $user->forceFill(['account_id' => $primaryAccount->id])->saveQuietly();
        }

        $workspaces = Workspace::where('account_id', $user->account_id)->get();
        if ($workspaces->isEmpty()) {
            $workspaces = Workspace::all();
        }

        foreach ($workspaces as $workspace) {
            if (! $workspace->members()->where('user_id', $user->id)->exists()) {
                $workspace->members()->attach($user->id, ['role' => 'admin']);
            }
        }

        if (! $user->current_workspace_id || ! Workspace::where('id', $user->current_workspace_id)->exists()) {
            $firstWorkspace = $workspaces->first();
            if ($firstWorkspace) {
                $user->forceFill(['current_workspace_id' => $firstWorkspace->id])->saveQuietly();
            }
        }
    }

    /**
     * Build the redirect URL for the centralized login portal.
     */
    public function getLoginUrl(?string $returnUrl = null): string
    {
        $baseUrl = rtrim(config('trypost.weretrade_sso.login_service_url', 'https://login.weretrade.com'), '/');
        $callbackUrl = $returnUrl ?: route('auth.weretrade.callback');
        if (str_starts_with(config('app.url'), 'https://') && str_starts_with($callbackUrl, 'http://')) {
            $callbackUrl = 'https://' . substr($callbackUrl, 7);
        }

        return "{$baseUrl}/api/auth/sso?redirect=" . urlencode($callbackUrl);
    }
}
