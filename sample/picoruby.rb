class LedBlinker
  def initialize(pin)
    @pin = pin
  end

  def run
    3.times do |i|
      puts "tick=#{i}"
      sleep 0.2
    end
  end
end

blinker = LedBlinker.new(25)
blinker.run
