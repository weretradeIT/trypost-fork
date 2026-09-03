<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Services\WeretradeSsoService;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

class WeretradeSsoMiddleware
{
    public function __construct(
        private readonly WeretradeSsoService $sso
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        if (! Auth::check()) {
            $user = $this->sso->attemptAutoLogin($request);
            if ($user) {
                Auth::login($user, remember: true);
                if ($request->hasSession()) {
                    $request->session()->regenerate();
                }
            }
        }

        return $next($request);
    }
}
