<?php

declare(strict_types=1);

namespace App\Services\Social\BrowserBridge;

use App\Enums\SocialAccount\Platform;
use App\Exceptions\Social\ErrorCategory;
use App\Exceptions\Social\LinkedInPublishException;
use App\Exceptions\Social\XPublishException;
use App\Models\PostPlatform;
use App\Services\Social\ContentSanitizer;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class BrowserBridgePublisher
{
    public function publish(PostPlatform $postPlatform): array
    {
        $bridgeUrl = rtrim((string) config('trypost.browser_bridge.url', 'http://trypost-browser-publisher:3400'), '/');
        $bridgeSecret = (string) config('trypost.browser_bridge.secret', '');
        $timeout = (int) config('trypost.browser_bridge.timeout', 120);

        $account = $postPlatform->socialAccount;
        $content = $postPlatform->post->content
            ? app(ContentSanitizer::class)->sanitize($postPlatform->post->content, $postPlatform->platform)
            : '';

        $mediaItems = [];
        foreach ($postPlatform->post->mediaItems as $item) {
            $mediaItems[] = [
                'url' => $item->url,
                'mime_type' => $item->mime_type,
                'alt_text' => $item->alt_text,
            ];
        }

        $payload = [
            'post_id' => $postPlatform->post_id,
            'post_platform_id' => $postPlatform->id,
            'platform' => $postPlatform->platform->value,
            'username' => $account->username,
            'display_name' => $account->display_name,
            'text' => $content,
            'media' => $mediaItems,
        ];

        Log::info('[BrowserBridge] Dispatching post to browser publisher bridge', [
            'post_platform_id' => $postPlatform->id,
            'platform' => $postPlatform->platform->value,
            'username' => $account->username,
            'content_length' => mb_strlen($content),
        ]);

        try {
            $request = Http::timeout($timeout);
            if (! empty($bridgeSecret)) {
                $request->withToken($bridgeSecret);
            }

            $response = $request->post("{$bridgeUrl}/publish", $payload);
        } catch (\Throwable $e) {
            Log::error('[BrowserBridge] Failed to connect to browser publisher bridge', [
                'error' => $e->getMessage(),
                'bridge_url' => $bridgeUrl,
            ]);

            $this->throwPlatformException(
                $postPlatform->platform,
                "Browser publisher bridge unreachable: {$e->getMessage()}",
                ErrorCategory::Unknown
            );
        }

        if (! $response->successful() || ! $response->json('success')) {
            $errorMsg = $response->json('message') ?? $response->json('error') ?? "Browser bridge returned HTTP {$response->status()}";
            $categoryVal = $response->json('category') ?? ErrorCategory::Unknown->value;
            $category = ErrorCategory::tryFrom($categoryVal) ?? ErrorCategory::Unknown;

            Log::error('[BrowserBridge] Post rejected by browser publisher bridge', [
                'post_platform_id' => $postPlatform->id,
                'status' => $response->status(),
                'error' => $errorMsg,
            ]);

            $this->throwPlatformException(
                $postPlatform->platform,
                (string) $errorMsg,
                $category,
                (string) $response->body()
            );
        }

        $data = $response->json();

        Log::info('[BrowserBridge] Post published successfully via browser bridge', [
            'post_platform_id' => $postPlatform->id,
            'id' => $data['id'] ?? null,
            'url' => $data['url'] ?? null,
        ]);

        return [
            'id' => (string) ($data['id'] ?? $postPlatform->id),
            'url' => (string) ($data['url'] ?? ''),
        ];
    }

    private function throwPlatformException(
        Platform $platform,
        string $message,
        ErrorCategory $category,
        ?string $rawResponse = null
    ): never {
        if ($platform === Platform::X) {
            throw new XPublishException(
                userMessage: $message,
                category: $category,
                platformErrorCode: 'browser-bridge-failure',
                rawResponse: $rawResponse
            );
        }

        if ($platform === Platform::LinkedIn || $platform === Platform::LinkedInPage) {
            throw new LinkedInPublishException(
                userMessage: $message,
                category: $category,
                platformErrorCode: 'browser-bridge-failure',
                rawResponse: $rawResponse
            );
        }

        throw new RuntimeException($message);
    }
}
