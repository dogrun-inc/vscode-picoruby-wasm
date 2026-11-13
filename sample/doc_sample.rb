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

# ホバーでドキュメントの表示を確認するためのサンプル。
#
# == コードと装飾
# 二重バッククォート内の ``use `+value+` here`` は変更せず、
# 周囲の *強調* と +code+ は変換する。
#
# 2スペースでインデントしたコード:
#
#   puts "+literal+ *value*"
#
# 4スペースでインデントしたコード:
#
#     if ready
#       puts "+literal+ *value*"
#     end
#
# @param [Array[Integer]] values 型を先に書いた整数の配列
# @param mapping [Hash[String, Array[Integer]]] 名前を先に書いた入れ子の型
# @return [Hash[String, Array[Integer]]] 配列を含む結果
# @example インスタンス変数を含むコード
#   @balance = 1
#   @param = "+literal+ *value*"
#   if ready
#     puts @balance
#   end
# @example 別のコード例
#   puts "done"
def review_sample(values, mapping)
  { "values" => values }
end
