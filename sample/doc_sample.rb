# ユーザーのウォレット残高を更新し、UIへ反映する。
#
# == 注意事項
# 負の金額を指定すると例外が送出されます。
#
# @param amount [Integer] チャージする金額 (+単位: 円+)
# @param dry_run [Boolean] 実際には保存せずシミュレーションのみ行うか
# @return [Hash] 更新後の状態 (+:balance+ と +:updated_at+)
# @raise [ArgumentError] +amount+ が 0 以下の場合
# @example 通常のチャージ
#   wallet.deposit(1000)
# @example シミュレーション
#   wallet.deposit(500, dry_run: true)
def deposit(amount, dry_run: false)
  raise ArgumentError, "invalid amount" if amount <= 0
  # 実装
end

# :nodoc:
# 内部向けの処理です。
def internal_update
end
