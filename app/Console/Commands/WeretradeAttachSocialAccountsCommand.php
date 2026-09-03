<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Enums\SocialAccount\Platform;
use App\Enums\SocialAccount\Status;
use App\Models\SocialAccount;
use App\Models\Workspace;
use Illuminate\Console\Command;
use Illuminate\Support\Str;

class WeretradeAttachSocialAccountsCommand extends Command
{
    protected $signature = 'weretrade:attach-social-accounts';
    protected $description = 'Attach weretrade persona social accounts (Bob Weber, Hanna Thoma, Corporate) to their workspaces';

    public function handle(): int
    {
        $this->info('🚀 Attaching weretrade persona social accounts to workspaces...');

        $definitions = [
            'Bob Weber — B2B Operations & Logistics' => [
                [
                    'platform' => Platform::X,
                    'platform_user_id' => 'bob_w1408',
                    'username' => 'bob_w1408',
                    'display_name' => 'Bob Weber',
                    'access_token' => 'session_bob_weber_x_auth',
                    'meta' => [
                        'email' => 'bob.weber1408@gmail.com',
                        'profile_url' => 'https://x.com/bob_w1408',
                    ],
                ],
                [
                    'platform' => Platform::LinkedIn,
                    'platform_user_id' => 'bob-wt-ab1559426',
                    'username' => 'bob-wt-ab1559426',
                    'display_name' => 'Bob Weber',
                    'access_token' => 'session_bob_weber_li_auth',
                    'meta' => [
                        'email' => 'bob.weber1408@gmail.com',
                        'profile_url' => 'https://www.linkedin.com/in/bob-wt-ab1559426/',
                    ],
                ],
            ],
            'Hanna Thoma — Customer Experience & Community' => [
                [
                    'platform' => Platform::X,
                    'platform_user_id' => 'weretradeHanna',
                    'username' => 'weretradeHanna',
                    'display_name' => 'Hanna Thoma',
                    'access_token' => '9dde29e0782c43dedbdba2d6a3fe0c4816163202',
                    'meta' => [
                        'email' => 'hanna.t0710@gmail.com',
                        'profile_url' => 'https://x.com/weretradeHanna',
                    ],
                ],
                [
                    'platform' => Platform::LinkedIn,
                    'platform_user_id' => 'hanna-wt-463566426',
                    'username' => 'hanna-wt-463566426',
                    'display_name' => 'Hanna Thoma',
                    'access_token' => 'session_hanna_li_at',
                    'meta' => [
                        'email' => 'hanna.t0710@gmail.com',
                        'profile_url' => 'https://www.linkedin.com/in/hanna-wt-463566426/',
                    ],
                ],
            ],
            'weretradeIT Corporate & BauKlotzBude' => [
                [
                    'platform' => Platform::X,
                    'platform_user_id' => 'weretrade',
                    'username' => 'weretrade',
                    'display_name' => 'weretradeIT',
                    'access_token' => 'session_corporate_x_auth',
                    'meta' => [
                        'profile_url' => 'https://x.com/weretrade',
                    ],
                ],
                [
                    'platform' => Platform::LinkedInPage,
                    'platform_user_id' => 'weretradeit',
                    'username' => 'weretradeit',
                    'display_name' => 'weretradeIT',
                    'access_token' => 'session_corporate_li_auth',
                    'meta' => [
                        'profile_url' => 'https://www.linkedin.com/company/weretradeit',
                    ],
                ],
            ],
            'weretrade Admin\'s Workspace' => [
                [
                    'platform' => Platform::X,
                    'platform_user_id' => 'weretrade_admin',
                    'username' => 'weretrade',
                    'display_name' => 'weretradeIT Admin',
                    'access_token' => 'session_admin_x_auth',
                    'meta' => [
                        'profile_url' => 'https://x.com/weretrade',
                    ],
                ],
                [
                    'platform' => Platform::LinkedIn,
                    'platform_user_id' => 'weretrade_admin_li',
                    'username' => 'weretrade-admin',
                    'display_name' => 'weretradeIT Admin',
                    'access_token' => 'session_admin_li_auth',
                    'meta' => [
                        'profile_url' => 'https://www.linkedin.com/company/weretradeit',
                    ],
                ],
            ],
        ];

        foreach ($definitions as $workspaceName => $accounts) {
            $workspace = Workspace::where('name', $workspaceName)->first();
            if (! $workspace) {
                $this->warn("⚠️  Workspace not found: {$workspaceName}");
                continue;
            }

            $this->line("Processing workspace: <comment>{$workspaceName}</comment>");

            foreach ($accounts as $data) {
                $account = SocialAccount::where('workspace_id', $workspace->id)
                    ->where('platform', $data['platform'])
                    ->first();

                $scopes = match ($data['platform']) {
                    Platform::LinkedIn => ['w_member_social', 'openid', 'profile', 'email'],
                    Platform::LinkedInPage => ['w_organization_social', 'openid', 'profile', 'email'],
                    Platform::X => ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
                    default => [],
                };

                if (! $account) {
                    $account = SocialAccount::create([
                        'id' => (string) Str::uuid(),
                        'workspace_id' => $workspace->id,
                        'platform' => $data['platform'],
                        'platform_user_id' => $data['platform_user_id'],
                        'username' => $data['username'],
                        'display_name' => $data['display_name'],
                        'access_token' => $data['access_token'],
                        'scopes' => $scopes,
                        'status' => Status::Connected,
                        'is_active' => true,
                        'meta' => $data['meta'],
                        'last_verified_at' => now(),
                    ]);
                    $this->info("  ✅ Connected {$data['platform']->label()} (@{$data['username']})");
                } else {
                    $account->update([
                        'platform_user_id' => $data['platform_user_id'],
                        'username' => $data['username'],
                        'display_name' => $data['display_name'],
                        'scopes' => $scopes,
                        'status' => Status::Connected,
                        'is_active' => true,
                        'meta' => $data['meta'],
                        'last_verified_at' => now(),
                    ]);
                    $this->line("  🔄 Refreshed {$data['platform']->label()} (@{$data['username']})");
                }
            }
        }

        $this->newLine();
        $this->info('🎉 All persona social accounts connected successfully!');
        return self::SUCCESS;
    }
}
