<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Enums\PostPlatform\Status as PostPlatformStatus;
use App\Enums\SocialAccount\Platform;
use App\Models\Post;
use App\Models\PostPlatform;
use App\Models\SocialAccount;
use App\Services\Social\BrowserBridge\BrowserBridgePublisher;
use Illuminate\Console\Command;
use Illuminate\Support\Str;

class WeretradeTestBrowserPublishCommand extends Command
{
    protected $signature = 'weretrade:test-browser-publish 
                            {platform : Platform to publish to (x, linkedin, linkedin-page)} 
                            {username : Account username (e.g. weretradeHanna, bob_w1408)} 
                            {--text= : Custom text to publish}
                            {--dry-run : Only ping the bridge without publishing}';

    protected $description = 'Test the local headless browser publishing bridge directly';

    public function handle(BrowserBridgePublisher $publisher): int
    {
        $platformInput = strtolower($this->argument('platform'));
        $username = $this->argument('username');
        $text = $this->option('text') ?? "weretradeIT Browser Bridge Test at " . now()->toIso8601String();
        $dryRun = (bool) $this->option('dry-run');

        $platform = Platform::tryFrom($platformInput);
        if (! $platform) {
            $this->error("Invalid platform: {$platformInput}. Allowed: x, linkedin, linkedin-page");
            return self::FAILURE;
        }

        $account = SocialAccount::where('platform', $platform)
            ->where(function ($q) use ($username) {
                $q->where('username', $username)
                  ->orWhere('platform_user_id', $username);
            })
            ->first();

        if (! $account) {
            $this->error("Social account not found for platform [{$platform->value}] and username [{$username}]");
            return self::FAILURE;
        }

        $this->info("Found account: {$account->display_name} (@{$account->username}) [{$account->id}]");
        $this->info("Workspace: {$account->workspace->name} [{$account->workspace_id}]");

        if ($dryRun) {
            $bridgeUrl = config('trypost.browser_bridge.url');
            $this->info("Dry-run mode: pinging bridge at {$bridgeUrl}/health...");
            try {
                $res = \Illuminate\Support\Facades\Http::get("{$bridgeUrl}/health");
                $this->line("Health response: " . $res->body());
                return $res->successful() ? self::SUCCESS : self::FAILURE;
            } catch (\Throwable $e) {
                $this->error("Bridge connection failed: {$e->getMessage()}");
                return self::FAILURE;
            }
        }

        $this->line("Preparing temporary post for bridge test...");

        // Create temporary in-memory Post & PostPlatform
        $post = new Post([
            'id' => (string) Str::uuid(),
            'workspace_id' => $account->workspace_id,
            'user_id' => $account->workspace->owner_id ?? $account->user_id,
            'content' => $text,
            'status' => 'publishing',
        ]);
        $postPlatform = new PostPlatform([
            'id' => (string) Str::uuid(),
            'post_id' => $post->id,
            'social_account_id' => $account->id,
            'platform' => $platform,
            'platform_username' => $account->username,
            'platform_name' => $account->display_name,
            'status' => PostPlatformStatus::Publishing,
        ]);
        $postPlatform->setRelation('post', $post);
        $postPlatform->setRelation('socialAccount', $account);

        $this->info("Dispatching to BrowserBridgePublisher: \"{$text}\"");

        try {
            $result = $publisher->publish($postPlatform);
            $this->info("✅ SUCCESS!");
            $this->table(['Key', 'Value'], [
                ['Platform', $platform->value],
                ['Username', $account->username],
                ['Post ID', $result['id'] ?? 'N/A'],
                ['Post URL', $result['url'] ?? 'N/A'],
            ]);
            return self::SUCCESS;
        } catch (\Throwable $e) {
            $this->error("❌ FAILED: {$e->getMessage()}");
            return self::FAILURE;
        }
    }
}
