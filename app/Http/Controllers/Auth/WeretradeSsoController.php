<?php

declare(strict_types=1);

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Services\WeretradeSsoService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class WeretradeSsoController extends Controller
{
    public function redirect(Request $request, WeretradeSsoService $sso): RedirectResponse
    {
        abort_unless(config('trypost.weretrade_sso_enabled', true), 404);

        if (Auth::check()) {
            return redirect()->route('app.home');
        }

        return redirect()->away($sso->getLoginUrl());
    }

    public function callback(Request $request, WeretradeSsoService $sso): RedirectResponse
    {
        abort_unless(config('trypost.weretrade_sso_enabled', true), 404);

        if (Auth::check()) {
            return redirect()->route('app.home');
        }

        $user = $sso->attemptAutoLogin($request);

        if ($user) {
            Auth::login($user, remember: true);
            $request->session()->regenerate();
            return redirect()->intended(route('app.home'));
        }

        return redirect()->route('login')->withErrors([
            'email' => 'weretrade SSO authentication failed. Please sign in with your credentials or try again.',
        ]);
    }
}
